# EPG Channel contract

A **Channel** is an XMLTV channel with a provider category and a scan policy, stored in D1 independently of the shows that name it. The decision is [ADR 0187](../../adr/0187-epg-channel-authority.md) (Proposed); the schema is in the [D1 schema reference](../data/d1-schema.md#epg-channel-authority-schema-v31-dormant-not-applied) and the module is `src/epg-channel-d1.js`. **Nothing in the Worker reads these tables yet**: the contract is dormant until a separately approved change reads one snapshot.

## Policies

| Policy | Meaning for a channel |
| --- | --- |
| `deny_all` | The channel is excluded from Discovery. |
| `discover` | The channel may feed Discovery. |
| `known_only` | Only films that are already known are processed; the fallback for anything unclassified. |

The exact scan behavior of each value is defined where a scan consumes it, not here.

## Effective policy

`owner override > category policy > known_only`. It is derived on read and never stored.

| Channel state | Policy | `basis` |
| --- | --- | --- |
| Has an override | the override | `override` |
| Has a category | the category policy | `category` |
| Listed but no category | `known_only` | `unclassified` |
| Id not in the snapshot | `known_only` | `unknown` |
| Snapshot unavailable, absent, torn or incomplete | `known_only`, `degraded:true` | `unavailable` |

A missing authority is never `discover`.

## Identity

The key is the XMLTV id (`ch001`, `ch1259`); the provider spelling is kept as `source_id`. `tvg_<n>` normalizes to `ch<n>` padded to at least three digits (`tvg_1259` to `ch1259`, `tvg_1` to `ch001`). The id is never matched by channel name. A malformed id (including a leading-zero spelling such as `tvg_001`), a duplicate normalized id, a duplicate provider id and a group no declaration names are source errors; one error refuses the whole import and nothing is written.

## Snapshot and writes

- `readSnapshot` checks that the tables exist, then reads the revision, the categories, the channels and the revision again (one metadata query plus four data queries, for any number of channels), retries once when the revision moved, and proves completeness against the stored row counts and each row's revision. A scan looks policies up in memory; there is no per-channel read.
- `commitImport` replaces classification and category policy from one source at an expected revision. It never deletes a channel: one the import no longer lists is kept, unclassified (`known_only` unless it has an override) and reported `listed:false`; every override survives. It writes nothing only when the digest of the whole normalized plan (computed by the repository, covering the category policies) equals the stored one at the current revision; the provider-file digest is provenance and never decides the no-op.
- `setOverride` sets or clears the override of one known channel at an expected revision.
- Both writes are one fenced batch: the revision is advanced with a compare-and-swap, a fence statement aborts the batch when it changed nothing, so two writers on one revision cannot both win. A lost reply is success only when the stored state is exactly the request: the whole-plan digest for an import, policy, note and time for an override.

## Boundaries

Shows keep their own keys. There is no foreign key to `published_epg_show` or `discovery_observation_show`. Applying the migration, importing and reading the policy in a scan are separate owner-approved operations.
