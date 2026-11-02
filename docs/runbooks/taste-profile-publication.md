# Taste-profile publication — operator procedure

> **Owner approval required.** Publishing a taste profile changes the current profile and refreshes the prediction queue. This page is the procedure, not the approval. Do not send `PUT /api/enrichment/profile`, including `dryRun: true` against production, and do not start a prediction run, while a prediction-domain migration is still comparing that state. The dated gate is the [AIR-20 gap matrix](../evidence/prediction/air-20-gap-matrix-2026-11-02.md). Validate the current schema, the tool contract and the live profile before any later, separately approved publication. Consult the [enrichment API reference](../reference/api/enrichment.md) and [runner contract](../reference/api/prediction-runner.md).

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
   5. For an unchanged approved request body and declaration hash, submit the approved publication **once**, without a redundant second dry-run. The Worker validates the approval, the declared changed fields and the expected `from` at write time; a mismatch is refused. Run a second dry-run only if the declaration, profile, expected source version or approval metadata changed, or the first result was ambiguous.

   Any change to the selectors, the changed fields or the profile body changes the hash and needs a new approval (`approval_mismatch`).
4. Check the answer: the new `version`, `changeImpact` and a `lineage` ending with this version.

**On a refusal**, nothing was written; fix the named `code` and send again. **On HTTP 409 `from_mismatch` or `profile_changed`**, another version became current in the meantime: start again from step 1. **On a timeout or HTTP 5xx**, first read the current profile and version identity to determine whether publication already completed; if it did, stop. If the expected `from` still matches and the immutable version record can be safely reused under the current contract, retry the **identical** approved request; do not change version or impact merely to overcome uncertainty. If the state cannot be established, stop for investigation. **On HTTP 409 `version_exists`**, a different record already holds that number: choose the next number. Never delete or rewrite a version record.

`GET /api/enrichment/profile` returns the published profile, including `changeImpact` and `lineage`, or 404 before the first publication. The Site footer shows the current version and publication date and does not show hashes. The film list keeps the last committed prediction. A prediction the selective rule still accepts stays in place; one it does not accept is marked as waiting for a recompute and is not hidden.

Freshness is the selective rule ([ADR-0031](../adr/0031-selective-prediction-profile-compatibility.md), [ADR 0044](../adr/0044-retire-profile-compatibility-switch.md)). There is no switch. An exact prediction stays current. A prediction also stays current when every published impact between its own profile and the current one is an approved selective impact that does not reach it, and when its stored profile hash equals the current profile hash (`content_identical`). A global impact, an unknown impact or a missing approval fails closed for the predictions it reaches. `anchorFilms`, `ratingScale` and `calibration` cannot be selective. A selective declaration cannot be used to shrink that blast radius. Fingerprints are not regenerated because the profile changed. The queue still counts the strict outcome beside the decision. The [compatibility reference](../reference/domain/prediction-compatibility.md) lists the consumers. The D1 prediction projection has no lineage and stays strict; this procedure does not change that projection.

**Restoring earlier content.** Publish that body as the next higher version. Do not point current at an older number, do not rewrite a version record, and do not rewrite a prediction's stored profile version or hash. Default `changeImpact` to `global` unless the owner approves a selective declaration for that exact diff. Predictions whose stored hash equals the republished body are `content_identical` and stay usable. Predictions made under the version being left follow the impacts in between.

**Deploying an older publisher.** That is a code rollback, not a content restore. An older publisher ignores `changeImpact` and `lineage` and does not write version records create-only. After such a deploy, choose a version number above every existing version record. This page does not authorize that deploy.

