# Taste-profile publication — operator procedure

> **Owner approval required:** publishing a new taste profile can invalidate predictions and change R2 records. This historical manual procedure is retained as guidance, not permission to run it. Validate current schema, tool contracts and profile status first. Consult the [enrichment API reference](../reference/api/enrichment.md) and [runner contract](../reference/api/prediction-runner.md).

## Publish a taste profile manually from Project Movies

First read `GET /api/enrichment/schema`. `PUT /api/enrichment/profile` accepts:

```json
{
  "version": 1,
  "schemaVersion": 1,
  "profile": {
    "ratingScale": "How the 0.5–5.0 Letterboxd scale should be used",
    "positiveSignals": ["A specific positive pattern"],
    "negativeSignals": ["A specific negative pattern"],
    "characterLogic": "Rules for character decisions and competence",
    "pace": "Pacing preferences",
    "payoffEnding": "Weight of payoff and ending",
    "genrePreferences": "General genre preferences",
    "comedyPreferences": "Comedy-specific preferences",
    "horrorPreferences": "Horror-specific preferences",
    "scifiAdventurePreferences": "Sci-fi and adventure preferences",
    "actionPreferences": "Action preferences",
    "anchorFilms": [{"title":"Example film","rating":4.5,"reason":"Why it got this rating"}],
    "hardSkips": ["A severe negative pattern"],
    "calibration": "Guidance for predicted rating and probability 4+"
  }
}
```

Each text field must be nonempty. `anchorFilms` can be empty if no anchored actual ratings are ready. `positiveSignals`, `negativeSignals`, and `hardSkips` are string arrays. The server computes `profileHash`, writes an immutable version record create-only, then moves the current pointer by compare-and-swap. Versions must increase. This is intentionally manual: the scheduled job never reads Project files or memory.

The body above is the **first** publication only. Every later version adds a `changeImpact` ([contract](../reference/api/enrichment.md#taste-profile-publication), [ADR-0031](../adr/0031-selective-prediction-profile-compatibility.md)). A publication without it is refused and changes nothing.

## Publish a later version

1. Read `GET /api/enrichment/profile` and note `version` and `profileHash`; they become `changeImpact.from`.
2. **Default to `global`.** Unless the owner has decided otherwise for this edit, send `{"impactSchemaVersion": 1, "from": {...}, "scope": "global", "changedFields": [...], "selectors": []}`. `changedFields` lists every top-level profile field whose value changes; the Worker computes the same list and refuses a mismatch (`changed_fields_mismatch`, the answer names the fields it found). Use `identity` only when the profile body is unchanged.
3. **Selective scope needs the owner's review of the exact declaration.**
   1. Draft the selectors under the field table of ADR-0031 section 4.
   2. Send the full body with `"dryRun": true` and no `approval`. The refusal `selective_requires_owner_approval` carries `declarationSha256` and the new `profileHash`, or a structural code to fix first. A dry run writes nothing.
   3. Record the owner's decision on that exact declaration (for example a comment on the Trello card naming the fields, the selectors and the hash).
   4. Add `"approval": {"approvedBy": "owner", "approvedAt": "<ISO time>", "reviewRef": "<that decision>", "declarationSha256": "<hash>"}`.
   5. Dry-run again (`valid: true`), then send without `dryRun`.

   Any change to the selectors, the changed fields or the profile body changes the hash and needs a new approval (`approval_mismatch`).
4. Check the answer: the new `version`, `changeImpact` and a `lineage` ending with this version.

**On a refusal**, nothing was written; fix the named `code` and send again. **On HTTP 409 `from_mismatch` or `profile_changed`**, another version became current in the meantime: start again from step 1. **On a timeout or HTTP 5xx**, send exactly the same request again: if the version record was already written, the retry reuses it and completes the pointer move. **On HTTP 409 `version_exists`**, a different record already holds that number: choose the next number. Never delete or rewrite a version record.

`GET /api/enrichment/profile` returns the published profile or 404 before publication. The Site footer displays the current version. Publishing a new version makes old predictions stale without deleting them or invalidating fingerprints. The change impact does not change that yet: every consumer still compares the profile version and hash strictly until the selective evaluator is implemented and activated by separate approvals.

**Rollback.** A code rollback restores the earlier publisher, which ignores `changeImpact` and `lineage` and writes the pointer without them; the next publication under this contract starts the lineage again from that record. The earlier publisher also writes version records without the create-only condition, so after a rollback choose a version number above any existing version record. Publishing an earlier profile content again is a new version with its own impact.

