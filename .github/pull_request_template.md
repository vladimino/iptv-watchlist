Trello: [AIR-NNN — card title](https://trello.com/c/XXXXXXXX). Prerequisites: <!-- linked cards and their Done state, or "none" -->

## What

<!-- The bounded change in the card's own terms: modules, functions, routes, data, docs. Say what is explicitly out of scope. -->

## Tests

<!-- Which test files cover the change and what they prove. Local results: `npm ci`, `npm test` (N files), `npm run build`. For UI or Mermaid work, the written Visual QA report at desktop and mobile widths goes here; no screenshots in git. -->

## Production impact

<!-- None / which runtime path, R2 or D1 object, Access rule, flag or Scheduled Task changes, and how to roll back. A code deploy never authorizes a live data write, flag change or scheduled run. -->

## Documentation governance

<!-- Required by docs/process/documentation-governance.md and checked by scripts/check-documentation-governance.mjs in the "Test and build" job. Keep the three lines below as standalone lines with exactly these labels; the check fails while they are empty.
- Documentation impact: the affected docs paths (reference, runbook, ADR, diagram, evidence, README), or `none - <concrete reason>`.
- Architecture impact: `changed` (then the diff must add a new docs/adr/NNNN-*.md, touch a docs/architecture/*.md diagram and a docs/reference/*.md contract) or `none - <reason>`.
- Research evidence: `yes` (then the diff must change a docs/evidence/ file) or `no`.
A change that mentions a registered feature flag in src/ or wrangler.jsonc must also update docs/reference/feature-flags.md. -->

Documentation impact:
Architecture impact:
Research evidence:
