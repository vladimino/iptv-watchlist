# ADR 0143: Assessment conflict positions may carry a caller-reported author, so one page source can hold several opinions

**Status:** Accepted (refines [ADR 0132](0132-prediction-assessment-artifact.md))
**Original decision date:** 2026-11-14
**Recorded at:** 2026-11-14
**Approval source:** Owner decision of 14 November 2026 recorded on [AIR-481](https://trello.com/c/ArYa99cg), which also places further [AIR-473](https://trello.com/c/b9oTfOpI) experiments after this change.
**Supersedes:** None. It narrows one rule of ADR 0132 (conflict positions name distinct sources).
**Superseded by:** None

## Context
Several independent reviews on one page share a URL. The v2 validator rejects a duplicated `assessment.sources(kind,ref)` and required unique `source` indices in `assessment.conflicts.positions`, so the model got `invalid_ref` or dropped the structured disagreement.

## Decision
1. `source` identifies a page; the new optional `positions[].author` (text 1 to 80) identifies one opinion on it.
2. A `source` index may repeat inside one conflict only if every position naming it has an `author` and the authors are distinct after trim and case folding. Otherwise: missing author is `assessment.conflicts.positions.author required`, empty or malformed is the usual `empty`/`invalid_type`/`too_long`, duplicates are `assessment.conflicts.positions invalid_ref`.
3. Positions with distinct indices work as before with or without `author`.
4. `author` is caller-reported (stored under `callerReported.conflicts`); the Worker checks shape and distinctness only, never fetches the page or certifies authorship. Callers must not invent authors or permalinks, or split one text into two opinions. Without distinguishable authors the disagreement stays in `ratingBasis`/`uncertainties`.
5. Unchanged: duplicate `sources(kind,ref)` stay forbidden, limits (2 conflicts, 2-3 positions, 6 sources, 3000 UTF-8 bytes), `assessmentVersion` 1, v5 refusing assessments, checksums, replay and storage layout.

## Alternatives rejected
- Duplicate source entries for one URL: breaks provenance uniqueness.
- Fictitious URLs/fragments per author: invents provenance.

## Consequences and recovery
Existing payloads and immutable assessments read without migration or backfill. Rolling code back restores the old validator, so a payload with a repeated index or `author` would then be refused on re-submit (`unknown_field`/`invalid_ref`); already stored objects are not rewritten or deleted. No runtime, R2, D1, flag or Task change.
