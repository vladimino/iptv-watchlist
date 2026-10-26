---
name: trello
description: Exact call shapes for the Trello MCP tools (trelloSearch, trelloReadCard, trelloWriteCard) on the IPTV Watchlist roadmap. Use before the first Trello call in a session — finding an AIR card, reading it, or commenting on it — so no call fails on argument validation.
---

# Trello MCP: call shapes that work

Every Trello tool takes a required `action`. Card ids are ARIs, not bare ids.

## Find a card (e.g. "AIR-168")

```
trelloSearch  { "action": "search_cards", "query": "AIR-168" }
```

- `action` is required and is `search_cards` or `search_boards`; there is no `search`.
- The result already carries the full description, list and URL; usually no separate read is needed.

## Read a card

```
trelloReadCard { "action": "get", "cardIdOrUrl": "ari:cloud:trello::card/workspace/<workspaceId>/<cardId>" }
```

- The parameter is `cardIdOrUrl`, and it takes the card ARI from the search result (`id`) or a card URL (`https://trello.com/c/<shortLink>`). A bare 24-character id is rejected.

## Comment on a card (handoff / fix note, in Russian)

```
trelloWriteCard { "action": "add_comment", "cardId": "ari:cloud:trello::card/workspace/<workspaceId>/<cardId>", "text": "..." }
```

- Here the parameter is `cardId` (not `cardIdOrUrl`), with the same ARI.

## IPTV Watchlist specifics

- Workspace id: `6ac52b0194055f651d4d865b`; board "IPTV Watchlist Roadmap".
- The developer only posts handoff-to-review and fix-note comments; never moves or closes cards and never posts Done evidence.
