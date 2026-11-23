<!-- Replace the placeholder link with the real card; CI does not validate it, review does. For the exceptional owner-approved delivery without a card write `Trello: none — <reason>`. -->
Trello: [AIR-NNN — card title](https://trello.com/c/XXXXXXXX). Prerequisites: <!-- linked cards and their Done state, or "none" -->

## What

<!-- The bounded change in the card's own terms: modules, functions, routes, data, docs. Say what is explicitly out of scope. -->

## Tests

<!-- For code PRs list the local `npm ci`, `npm run test:all`, `npm run build` outcomes, test count and exact verified commit SHA. Rerun after code changes. Docs-only changes can state not applicable for the expensive suite. Local Git hooks can be bypassed; reviewers must inspect the evidence. For UI or Mermaid work, give written Visual QA for desktop and mobile; no screenshots in git. -->

## Production impact

<!-- None / which runtime path, R2 or D1 object, Access rule, flag or Scheduled Task changes, and how to roll back. A code deploy never authorizes a live data write, flag change or scheduled run. -->

## Documentation governance

<!-- Required by docs/process/documentation-governance.md and checked by scripts/check-documentation-governance.mjs in the "Test and build" job. Keep the three lines below as standalone lines with exactly these labels; the check fails while they are empty, and editing this description re-runs it (the workflow listens to the `edited` event).
- Documentation impact: the affected docs paths (reference, runbook, ADR, diagram, evidence, README), or `none - <concrete reason>`.
- Architecture impact: `changed` (then the diff must add a new docs/adr/NNNN-*.md, touch a docs/architecture/*.md diagram and a docs/reference/*.md contract) or `none - <reason>`.
- Research evidence: `yes` (then the diff must change a docs/evidence/ file) or `no`.
A change that mentions a registered feature flag in src/ or wrangler.jsonc must also update docs/reference/feature-flags.md. -->

Documentation impact:
Architecture impact:
Research evidence:

<!-- For PRs adding or modifying a numbered ADR or its register row: link the Product Owner's explicit decision on the ADR number and chosen option, and make both ADR and register say Accepted or Rejected before merge. Proposed ADR PRs remain open. For unrelated PRs write `none - no ADR affected`. A Rejected ADR may be archived only in a docs-only PR without rejected implementation. The policy is mandatory but is not yet CI-enforced. -->
ADR owner decision:
