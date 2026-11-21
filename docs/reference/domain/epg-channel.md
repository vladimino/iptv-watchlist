# EPG Channel contract

A **Channel** is an XMLTV channel with a provider category, an optional owner category and a scan policy, stored in D1 independently of the shows that name it. The decision is [ADR 0187](../../adr/0187-epg-channel-authority.md) (Accepted design, dormant implementation); the schema is in the [D1 schema reference](../data/d1-schema.md#epg-channel-authority-schema-v32-applied-to-production-empty) (schema v32) and the module is `src/epg-channel-d1.js`. **No scan reads these tables yet**: the stored policy is *staged*, not active, until a separately approved change reads one snapshot. Since AIR-562 the only Worker code that touches them is the owner-only [Channel admin](../api/admin.md#channels-api-admin-channels) (`src/admin/channels.js`), which fails closed while schema 32 is absent. That future consumer precomputes an in-memory `Map<channelId, {policy, basis}>` once per scan revision and does one lookup per show.

## Policies

| Policy | Meaning for a channel |
| --- | --- |
| `deny_all` | The channel is excluded from Discovery. |
| `discover` | The channel may feed Discovery. |
| `known_only` | Only films that are already known are processed; the fallback for anything unclassified. |

The exact scan behavior of each value is defined where a scan consumes it, not here.

## Effective policy

`owner policy override > owner category policy > provider category policy > known_only`. It is derived on read and never stored.

| Channel state | Policy | `basis` |
| --- | --- | --- |
| Has an owner policy override | the override | `override` |
| Has an owner category | that category's policy | `owner_category` |
| Has a provider (M3U) category | that category's policy | `category` |
| No category at all, including a channel registered from XMLTV alone | `known_only` | `unclassified` |
| Id not in the snapshot | `known_only` | `unknown` |
| Snapshot unavailable, absent, torn or incomplete | `known_only`, `degraded:true` | `unavailable` |

A missing authority is never `discover`.

## Identity

The key is the XMLTV id (`ch001`, `ch1259`); the provider spelling is kept as `source_id`, which is empty for a channel only XMLTV lists (registered with `origin` `xmltv`, unclassified, so `known_only`). An XMLTV id that an M3U entry normalizes to is the same channel; the M3U name and provider id win, and the registration origin never changes. A duplicate XMLTV id and a malformed one are source errors. `tvg_<n>` normalizes to `ch<n>` padded to at least three digits (`tvg_1259` to `ch1259`, `tvg_1` to `ch001`). The id is never matched by channel name. A malformed id (including a leading-zero spelling such as `tvg_001`), a duplicate normalized id, a duplicate provider id and a group no declaration names are source errors; one error refuses the whole import and nothing is written.

## Snapshot and writes

- `readSnapshot` checks that the tables exist, then reads the revision, the categories, the channels and the revision again (one metadata query plus four data queries, for any number of channels), retries once when the revision moved, and proves completeness against the stored row counts and each row's revision. A scan looks policies up in memory; there is no per-channel read.
- `commitImport` replaces the provider classification, the category policies and the XMLTV registrations from the sources at an expected revision. It never deletes a channel: one the import no longer lists is kept, unclassified (`known_only` unless it has an override) and reported `listed:false`; every override survives. It writes nothing only when the digest of the whole normalized plan (computed by the repository, covering the category policies) equals the stored one at the current revision; the provider-file digest is provenance and never decides the no-op.
- `setOverride` sets or clears the owner policy override of one known channel at an expected revision.
- `setOwnerCategory` assigns or clears the owner category of one known channel (the category must exist) at an expected revision. It is a durable field apart from the provider category: an import never writes or resets it, and a category an owner assignment points at is kept even when the import stops declaring it.
- Both writes are one fenced batch: the revision is advanced with a compare-and-swap, a fence statement aborts the batch when it changed nothing, so two writers on one revision cannot both win. A lost reply is success only when the stored state is exactly the request: the whole-plan digest for an import; policy, note and time for an override; category, note and time for an owner category.

## Admin and staging

The owner page `/admin/channels` ([API](../api/admin.md#channels-api-admin-channels), [runbook](../../runbooks/channel-management.md)) lists channels, queues the unclassified ones, sets owner categories and policy overrides, and imports an M3U that the browser parsed. It calls `commitImport`, `setOverride` and `setOwnerCategory` unchanged, so every rule above holds: an import never deletes a channel and never writes an owner category or override, and every write is a compare-and-swap at the revision the page read. What the page saves is **staged** policy: it changes the Channel revision, not any EPG or Discovery behavior. The exact scan behavior of each policy, and the first live effect, belong to the later reader change.

## Boundaries

Shows keep their own keys. There is no foreign key to `published_epg_show` or `discovery_observation_show`. Applying the migration, importing and reading the policy in a scan are separate owner-approved operations.
