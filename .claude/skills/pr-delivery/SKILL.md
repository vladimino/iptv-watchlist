---
name: pr-delivery
description: The exact pull request body that passes the IPTV Watchlist documentation governance check (Documentation impact / Architecture impact / Research evidence lines) and the rest of the PR template. Use before opening or editing any PR on this repository through the GitHub API or MCP tools, where the web template is not applied, so the "Test and build" job does not go red on the body.
---

# PR delivery: a body that passes the governance check

`scripts/check-documentation-governance.mjs` runs first in the PR **Test and build** job and fails the whole job on the PR *body*, before any test. A PR opened through the API or an MCP tool does not get [the PR template](../../../.github/pull_request_template.md), so the three lines below must be written by hand, exactly in this shape. Editing the description re-runs the check (the workflow listens to `edited`); a manual re-run of the failed job keeps the old body and stays red.

## The three lines (verbatim shapes)

Each one is a standalone line, label at the start of the line, a colon, the value on the **same** line. The value is matched case-insensitively from its first word.

```
Documentation impact: docs/reference/x.md, docs/runbooks/y.md
Documentation impact: none - test-only fixture, no documented behaviour changes
Architecture impact: changed
Architecture impact: none - documentation-only evidence; no code, topology or trust boundary change
Research evidence: yes
Research evidence: no
```

Rules the checker enforces:

- `none` needs a reason after a plain hyphen `-`, an en dash `–` or a colon `:`, with at least nine characters of text. An em dash `—` is **not** accepted ("none requires a reason"). Applies to both `Documentation impact` and `Architecture impact`.
- `Research evidence:` must start with `yes` or `no`. Anything else ("Research evidence: the report …") fails. Free text may follow the word (`yes - the dated report under docs/evidence/…`).
- `Architecture impact: changed` requires, in the same diff, a new `docs/adr/NNNN-*.md`, a `docs/architecture/*.md` page and a `docs/reference/*.md` page.
- `Research evidence: yes` requires a changed file under `docs/evidence/`; a PR that changes an evidence file says `yes`.
- A diff that mentions a registered feature flag name in `src/` or `wrangler.jsonc` must also change `docs/reference/feature-flags.md` (the name list lives in the checker).

## Body skeleton (what the template would have given)

```
Trello: [AIR-NNN — card title](https://trello.com/c/XXXXXXXX). Prerequisites: none

## What
<the bounded change in the card's terms; what is out of scope>

## Tests
<test files and what they prove; local `npm ci`, `npm test` (N files), `npm run build`; written Visual QA for UI or Mermaid work, no screenshots>

## Production impact
<None, or the runtime path, R2/D1 object, Access rule, flag or Scheduled Task touched, and the rollback. A code deploy never authorizes a live write, flag change or scheduled run.>

## Documentation governance
Documentation impact: <paths, or none - reason>
Architecture impact: <changed, or none - reason>
Research evidence: <yes or no>
```

Keep the lines even when a tool appends its own footer after them; position in the body does not matter, the shape does. Check the three lines once more before `create_pull_request` or `update_pull_request`; the full policy is in [documentation governance](../../../docs/process/documentation-governance.md).
