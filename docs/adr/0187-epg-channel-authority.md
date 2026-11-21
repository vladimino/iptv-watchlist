# ADR 0187: Channel, provider category and per-category policy become their own D1 entity, with the effective policy derived as owner policy override > owner category policy > provider category policy > `known_only`

**Status:** Proposed  
**Original decision date:** 2026-11-21 (proposal; the contested details below are not yet approved)  
**Recorded at:** 2026-11-21  
**Approval source:** The programme and the owner policy (categories 3-8 `discover`, the other 29 groups `deny_all`, unknown or unclassified `known_only`, an explicit owner override above the category policy) were agreed by the Product Owner on 2026-11-20/21 in the project conversation and recorded on the [Trello card](https://trello.com/c/K98arHAG). This ADR stays **Proposed** until the owner approves the architectural details listed under "Not decided".  
**Related work:** [AIR-561](https://trello.com/c/K98arHAG) (this decision and the dormant schema and repository); successors [AIR-562](https://trello.com/c/EGDxTW8m) (admin, M3U import, overrides), [AIR-563](https://trello.com/c/TzDy1d4b) (production migration and first import), [AIR-564](https://trello.com/c/omIQl2Lh) (scan policies and metrics), [AIR-565](https://trello.com/c/mSdBSd9j) (Discovery ledger cleanup)  
**Supersedes:** None  
**Superseded by:** None

## Context

Confirmed from the offline audit of 20 Nov 2026 (a baseline for dry runs, not an invariant): the provider M3U `playlist.m3u8` carries 35 `#EXTGRP` groups and 2 103 channel ids, the XMLTV source 1 355 channels, 1 340 ids match and 15 are not classified.

Today a channel is only a string. `published_epg_show.channel_id` and `discovery_observation_show.channel_id` carry the XMLTV id, and `channel` the display name. Nothing says which channels may feed Discovery, so every channel's shows are scanned the same way. The owner policy needs a place to live that is independent of the shows, can be changed without rewriting history and is read once per scan.

## Decision

1. **Channel is a D1 entity.** Three tables hold it (schema v31): `epg_channel_category` (provider category with its policy), `epg_channel` (one row per XMLTV channel id, with an optional provider id, an optional provider category, an optional owner category and an optional owner policy override) and `epg_channel_revision` (the one snapshot revision, the source digest and row counts), plus the batch fence `epg_channel_cas`. There is **no mode marker**: nothing reads the tables until a later, separately approved change does.
2. **Four things stay apart.** The *provider category* is `epg_channel.category_key`, written only by an import. The *owner category* is `epg_channel.owner_category_key`, a durable owner assignment that an import never writes or resets. The *policy* is `epg_channel_category.policy` or `epg_channel.override_policy`, each limited to `deny_all`, `discover` or `known_only`. The *provenance* is `epg_channel_revision.source_sha256` for the provider files, `epg_channel.origin` (`m3u` or `xmltv`, the source that first registered the channel), and `override_at` / `override_note` and `owner_category_at` / `owner_category_note` for the owner decisions. The **effective policy is never stored**; it is derived, in one place, as `owner policy override > owner category policy > provider category policy > known_only`.
3. **Single source of truth.** Classification and policy live only in these rows. A snapshot is one revision: every committed write adds one, a write names the revision it read (compare-and-swap in one fenced batch), and the row counts in the revision row let a reader prove it read every row. A read takes the revision, the categories, the channels and the revision again, and retries once when it moved.
4. **Fail safe, never `discover`.** An unknown channel id, a channel without any category (including one registered from XMLTV alone) and an empty snapshot are `known_only`. An unavailable database, absent tables, a torn or incomplete snapshot are reported explicitly (`ok:false` with a reason) and their lookup answers `known_only` with `degraded:true`. A missing authority never widens what Discovery may admit.
5. **One read per scan.** A consumer reads one snapshot (one table-existence query plus four data queries, for any number of channels) and looks policies up in memory. There is no per-channel D1 read and no slot-database lookup in a scan loop.
6. **Identity is the XMLTV id, never the name.** `tvg_<n>` normalizes to the XMLTV id `ch<n>` with at least three digits (`tvg_1259` is `ch1259`, `tvg_1` is `ch001`). A malformed id, a leading-zero spelling, a duplicate normalized id or a group nobody declared is a **source error** that refuses the whole import. A channel is never matched to another by its display name.
7. **A channel can be registered from XMLTV alone.** The XMLTV id is the key and the provider id is optional. An XMLTV id that an M3U entry normalizes to is the same channel (the M3U name and provider id win); an XMLTV id no M3U entry reaches is registered with `origin` `xmltv`, no provider id and no category, so it is `known_only` until the owner classifies it. The registration `origin` never changes. A duplicate or malformed XMLTV id is a source error.
8. **Film–Show–Channel boundary.** Shows keep their own keys and are never rewritten for this entity. There is **no foreign key** from `epg_channel` to `published_epg_show` or `discovery_observation_show`: a historical show may name a channel with no row, and a channel row may have no show.
9. **An import never deletes a channel.** An import replaces the provider classification, the category policies and the XMLTV registrations from the sources. A channel the import no longer lists is **kept**, loses its provider category (so it is `known_only` unless the owner decided otherwise) and reads `listed:false` (`last_seen_revision` below `import_revision`), for a later admin diff. Every owner decision (policy override and owner category) survives, and a category an owner assignment points at is kept even when the import stops declaring it. The import is a no-op only when the digest of the **whole normalized plan** (categories, policies, channels), computed by the repository and not supplied by the caller, equals the stored one at the current revision; the provider-file digest is provenance only, so a changed category policy over the same files is always written.
10. **A lost reply is success only for the exact request.** After a failed batch the stored state counts as ours only when it matches the request exactly: the whole-plan digest for an import; policy, note and time for an override; category, note and time for an owner category. Another writer's same-value decision with different metadata is reported as a conflict.

## Not decided

- Whether a later activation needs a staged or `held` authority (see alternative B). This ADR adds no marker because nothing reads the tables; that is a delivery choice for the dormant schema, not an owner decision about activation.
- The exact scan semantics of `deny_all`, `discover` and `known_only` and their metrics (a later change).
- The admin surface, the M3U fetching and the first production import, and any change to the active Discovery ledger.
- Whether an owner override or owner category may create a channel that neither source listed (this schema refuses it; see alternative C).
- Retention of channels that stay unlisted for a long time (kept indefinitely today); a later cleanup would be its own decision.

## Alternatives considered

These compare the choices this schema embodies. The Product Owner has agreed the policy values and decided alternatives F and G (the XMLTV-only registration and the separate owner category) in the review of this PR. Alternatives A to E below are the executor's proposal and **have not been decided by the owner**.

**A. Channels missing from a new import: retain or delete.**
- *Retain (chosen in this proposal).* Keeps every override and the agreed rule that an import never deletes channels, so a provider glitch or a partial M3U cannot erase owner decisions. Cost: rows accumulate and an unlisted channel needs a `listed` signal; the unclassified fallback is `known_only`.
- *Delete the unlisted channels without an override.* Keeps the table equal to the latest source. Cost: a short or damaged source silently removes channels and their history, which the successor admin work explicitly rules out.

**B. Authority marker: none, or staged/held.**
- *No marker while dormant (chosen in this proposal).* Nothing reads the tables, so a marker would gate nothing and applying the migration is trivially inert.
- *A staged marker (`dormant`/`open`) with `held` writes, like the other domains.* Gives an import fence and an explicit activation step. Cost: a switch with no reader today; it can be added by a later migration when a reader exists, at the price of one more schema change.

**C. Override on a channel the import never listed: refuse or create.**
- *Refuse (chosen in this proposal).* A channel exists only through an import, so provider id and category always come from one source.
- *Create on override.* Lets the owner pre-decide a channel before the provider lists it. Cost: a channel row with no provider id, which the unique `source_id` and the id normalization do not cover.

**F. Channels only XMLTV lists (the 15 of the audit baseline): persist or keep implicit.** The Product Owner chose to persist them (decided in the review of this PR).
- *Persist as channel rows without a provider id (chosen).* The reconciliation of 2,103 M3U plus 15 XMLTV-only channels (2,118 unique) is representable, and the owner can classify them. Cost: `source_id` is optional and each row records its registration `origin`.
- *Keep implicit (unknown, `known_only`).* No schema change. Cost: those channels cannot be persisted or classified, which would require revising the successor work that reconciles and classifies them.

**G. Owner category: a separate field, or only a policy override.** The Product Owner chose a separate durable field (decided in the review of this PR).
- *Separate `owner_category_key` (chosen).* A hand-assigned category survives every import and keeps its own provenance; the effective order becomes owner policy override > owner category policy > provider category policy > `known_only`. Cost: one more field and precedence step, and a category an owner points at is retained even when an import stops declaring it.
- *Policy override only.* Simpler. Cost: a manual category edit on the provider field would be reset by the next import, so manual classification would not be durable.

**D. Effective policy: derived or stored.** Derived (chosen): one rule in one place, no drift between category, override and a cached value. Stored: faster per-row reads. Cost: it can disagree with its inputs, and the read is already one in-memory snapshot.

**E. Foreign key to the show tables.** None (chosen): history keeps its keys and a show may name a channel with no row. A foreign key would constrain or rewrite historical rows.

## Consequences

The scan can apply one consistent policy snapshot without changing any show key. Retained unlisted channels make the table a superset of the latest source, so a consumer must read `listed` where absence matters. A new revision row is a single point of contention for writers, which is acceptable for an owner-controlled, low-frequency import and override surface. The module and tables are dormant; consumers must be added behind a separate approval.

## Recovery and migration boundary

The migration `0031_epg_channel_authority.sql` is **not applied by a deploy**; it follows a complete version 30 and refuses anything else before a table is created. Rollback of the code is a revert with no storage mutation. Applying the migration, importing and activating a reader are separate owner-approved steps; this ADR authorizes none of them.

## Evidence

- **Original decision:** the owner policy on the [Trello card](https://trello.com/c/K98arHAG).
- **Implementation:** the pull request of this change (offline tests in `tests/epg-channel-d1.mjs`).
- **Dated verification:** offline only; no production observation.
- **Uncertainty:** production sizes and the effect of D1's per-invocation statement budget on a full import are not measured; the test stand-in is sqlite.

## Follow-ups

[AIR-562](https://trello.com/c/EGDxTW8m), [AIR-563](https://trello.com/c/TzDy1d4b), [AIR-564](https://trello.com/c/omIQl2Lh), [AIR-565](https://trello.com/c/mSdBSd9j).
