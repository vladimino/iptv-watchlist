# Channel management (`/admin/channels`)

Owner procedure for classifying EPG channels with the [Channel admin](../reference/api/admin.md#channels-api-admin-channels). The contract is [EPG Channel](../reference/domain/epg-channel.md) and [ADR 0187](../adr/0187-epg-channel-authority.md). **Since AIR-565 ([ADR 0198](../adr/0198-retire-epg-channel-policy-flag.md)) every EPG scan applies the saved policy; there is no activation switch. A saved revision takes effect with the next natural EPG generation and nothing here starts EPG, Discovery or TMDB.** Applying migration `0032` to production and the first import were separate owner-approved operations ([AIR-563](https://trello.com/c/TzDy1d4b)); the scan consumer is [AIR-564](https://trello.com/c/omIQl2Lh). Until the schema exists the page says so and writes nothing.

## Before you start

- The page must show a revision, not "схема ещё не применена". If it shows the latter, stop: applying the schema is not part of this runbook.
- Read the banner: it says whether the scan policy is applied or unknown (from the API state, never assumed; since AIR-565 a successful read always reports it applied), and the revision is the one every save is pinned to. A save on a stale page is refused (409) and the list reloads; repeat the change on the new revision.

## Classify one channel

0. A row shows only *published Film shows* of the channel: "no published Film shows" does not mean the channel is off air.
1. Open the unclassified queue (tick "Только неклассифицированные"). An XMLTV-only channel appears there until it is classified; it is `known_only` meanwhile.
2. Pick an owner category (a durable assignment an import never changes) or a manual policy override (wins over every category), add the note of that decision (the category and the policy have separate notes), press the matching save button. Clearing means choosing the empty option and saving.
3. The row shows the effective policy and its basis: manual override, owner category, provider category or unclassified. The saved decision survives every later import.

## Import a new playlist

1. Choose the `.m3u`/`.m3u8` file. It is parsed in the browser; nothing is uploaded yet. The import is **all or nothing**: a file with any `#EXTINF` without a `tvg-id`, any `#EXTINF` without a stream line, a name or group that looks like a URL or a secret, or an over-long file is blocked and no preview is offered. Do not import a partial or damaged download as complete; fix or re-download the file. There is no partial-import mode.
2. Set the policy of each group (new groups default to `known_only`; known groups show the stored policy).
3. "Проверить разницу" sends only normalized `{id, name, group}` entries and shows: new, renamed, changed category, absent from the file, conflicts with owner decisions, category changes. It writes nothing.
4. Tick the confirmation and press "Записать импорт". The receipt shows the new revision. A channel absent from the file is **kept** without its provider category; owner categories and overrides are untouched.
5. If the answer is lost or says the outcome is unknown, reload the list and read the revision before repeating. Repeating the same import is safe: an identical stored plan is a no-op.

## Do not

- Do not expect an effect on the EPG, Discovery or the watchlist from a save.
- Do not paste or keep a playlist with stream URLs or tokens anywhere outside your own machine; the page never sends them.
- Do not use this page to create a channel: an unknown id is refused.

## Rollback

Code rollback hides the page and the routes and changes no stored data. To undo a decision, clear it on the page; to undo an import, import the previous playlist (a new revision). Neither touches EPG authority.

## Offline comparison harness (historical, not a production path)

The offline harness `scripts/epg-channel-policy-dry-run.mjs` is run on the real inputs (see its header for every argument): a local copy of the XMLTV feed with the time it was taken, the effective Channel policies (`--snapshot-rows` from the five read-only `SELECT` statements of the snapshot reader, or `--policies`), the watchlist and the discovered-films cache. It runs one feed through `legacy`, `filtered` and `degraded` purely as an offline comparison (the `legacy` run exists only inside this harness: no production path can start an unfiltered scan since [ADR 0198](../adr/0198-retire-epg-channel-policy-flag.md)), calls no D1 writer, and prints numbers only. Use it to check a changed policy against a real feed before relying on it; the verdict must be PASS with `lateDeclared` 0; a BLOCKED answer names the missing input and nothing is substituted. Keep the feed, the playlist, the film inputs and every slot key out of the repository, pull requests and Trello; only the numbers the card asks for go back. The exact checks and the way to obtain each input are in the [dated dry-run status](../evidence/epg-channel-policy-real-feed-dry-run-2026-11-21.md).

## Verification of the scan policy

The policy is always applied; `EPG_CHANNEL_POLICY` is retired and inert ([flag contract](../reference/feature-flags.md)). Nobody starts an EPG, Discovery or TMDB run to hurry a verification: the effect is the next natural EPG sync.

1. Before relying on a revision, read the Channel revision on the page and confirm the snapshot is the imported one (not empty). An empty or unreadable snapshot does not stop the EPG: the sync runs in `degraded` mode (every channel `known_only`, a warning in the event, no revision claimed) and does **not** apply the blacklist.
2. After the next natural EPG sync, read the new `epg` event (events screen): `policy.mode` must be `filtered` (a `degraded` event with its warning proves nothing about the blacklist: fix the snapshot and wait for the next natural run), `policy.revision` must equal the revision you read, `channels` and `programmes` must show the expected `deny_all` and `known_only` counters, and `channels.new` (detected) against `channels.registered` shows the declared XMLTV ids the sync added; they appear in the unclassified queue of this page, and a `channel_registration_failed` warning means the next natural sync retries.
3. With read-only checks confirm that the current published generation holds no show of a `deny_all` channel and that Discovery gained no candidate from a `known_only` channel.
4. If the sync failed for another reason, the previous generation is still published: read the error and wait for the next natural run. The first filtered or degraded generation after `legacy` (and a change between them) skips only the minimum-broadcasts check, never the raw, coverage or horizon checks. There is no routine way back to an unfiltered EPG and none is recommended: setting `EPG_CHANNEL_POLICY` to `off`, `on` or removing the binding changes nothing, because the flag is retired. A degraded generation is the safe fallback for a bad snapshot; fix the snapshot and wait for the next natural run.

## Exceptional code rollback

A code rollback is a revert with no stored-data change and does not undo a filtered generation that was already published. Reverting to a build that still reads `EPG_CHANNEL_POLICY` first requires restoring the binding to `on` under a separate, specific owner authorization; otherwise that older code would treat an absent binding as `legacy` and publish an unfiltered generation. Removing the retired binding from the Worker is a separate owner step after the retiring deploy, confirmed by a `feature_flags` readback of `state=absent`, `retired=true`.
