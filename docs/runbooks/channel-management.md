# Channel management (`/admin/channels`)

Owner procedure for classifying EPG channels with the [Channel admin](../reference/api/admin.md#channels-api-admin-channels). The contract is [EPG Channel](../reference/domain/epg-channel.md) and [ADR 0187](../adr/0187-epg-channel-authority.md). **Everything saved here is staged policy: no scan reads it and nothing here starts EPG, Discovery or TMDB.** Applying migration `0032` to production, the first import and any reader that makes the policy active are separate owner-approved operations ([AIR-563](https://trello.com/c/TzDy1d4b) applies the schema and runs the first import; the scan consumer is [AIR-564](https://trello.com/c/omIQl2Lh)). Until the schema exists the page says so and writes nothing.

## Before you start

- The page must show a revision, not "схема ещё не применена". If it shows the latter, stop: applying the schema is not part of this runbook.
- Read the banner: the revision is the one every save is pinned to. A save on a stale page is refused (409) and the list reloads; repeat the change on the new revision.

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
