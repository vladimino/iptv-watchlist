# EPG Channel contract

A **Channel** is an XMLTV channel with a provider category, an optional owner category and a scan policy, stored in D1 independently of the shows that name it. The decision is [ADR 0187](../../adr/0187-epg-channel-authority.md) (Accepted design); the schema is in the [D1 schema reference](../data/d1-schema.md#epg-channel-authority-schema-v32-applied-to-production-empty) (schema v32) and the module is `src/epg-channel-d1.js`. Since AIR-565 ([ADR 0198](../../adr/0198-retire-epg-channel-policy-flag.md)) every EPG scan reads one snapshot (`materializePolicies`) and applies it unconditionally ([scan semantics](candidate-discovery.md#channel-policy-in-the-epg-scan)); the former `EPG_CHANNEL_POLICY` switch is retired. The only Worker code that touches the tables is the owner-only [Channel admin](../api/admin.md#channels-api-admin-channels) (`src/admin/channels.js`), which fails closed while schema 32 is absent, and the scan loader (`loadEpgChannelPolicy` in `src/worker.js`). That consumer precomputes an in-memory `Map<channelId, {policy, basis}>` once per scan revision and does one lookup per show.

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

The owner page `/admin/channels` ([API](../api/admin.md#channels-api-admin-channels), [runbook](../../runbooks/channel-management.md)) lists channels, queues the unclassified ones, sets owner categories and policy overrides, and imports an M3U that the browser parsed. It calls `commitImport`, `setOverride` and `setOwnerCategory` unchanged, so every rule above holds: an import never deletes a channel and never writes an owner category or override, and every write is a compare-and-swap at the revision the page read. A save changes the Channel revision only and starts no EPG or Discovery run; the saved revision applies to the next natural EPG generation (AIR-565: no flag gates it). The exact scan behavior of each policy, and the first live effect, belong to the later reader change.

## Scan map and XMLTV registration

- `materializePolicies(env)` reads one consistent snapshot and returns `{ok, revision, digest, map}`: a `Map<channelId, {policy, basis}>` for every channel and the SHA-256 of the revision with the sorted entries, so the applied policy is reproducible from the `epg` event. An absent, incomplete, unavailable or empty (revision 0) snapshot answers `ok:false`, and the scan then runs in `degraded` mode (every channel `known_only`, a warning, no revision claimed) instead of refusing to publish.
- `registerXmltvChannels(env, {channels, now})` adds the XMLTV ids a snapshot lacks: origin `xmltv`, no provider id, no category, so the channel is `known_only` and appears in the unclassified queue. It is idempotent (an existing id is never re-created, renamed or reclassified; a repeat writes nothing and adds no revision), bounded (`MAX_CHANNELS`), identifies by XMLTV id only, skips a malformed id, and is a compare-and-swap on a fresh revision read with a bounded retry. A lost reply counts as success only when every new id (the whole bounded set, not a sample) is stored as an `xmltv` row at the new revision and the marker count equals the previous count plus the new ids. The scan feeds it the ids the feed declares, so a declared channel without a current programme is registered too; programme ids without a declaration are not. It changes no policy, so a scan that pinned an earlier revision is unaffected. A failure never fails the scan and is retried by the next one. The scan calls it once, at the declaration boundary of its single pass and only in `filtered` mode, not as a publish step, so the rows it wrote stay even if the EPG later fails.

## Boundaries

Shows keep their own keys. There is no foreign key to `published_epg_show` or `discovery_observation_show`. Applying the migration, importing and reading the policy in a scan are separate owner-approved operations.
