# AIR-317 fingerprint body inventory, 1 November 2026

**Captured:** 2026-11-01, the read-only pass finished about 20:10 UTC. The one-off script did not stamp its own clock. Production R2 bucket `iptv` on the production account. The client was the read-only snapshot credential (`writes: false`). No D1 query, no PUT, no migration, no marker change, no flag, cron, Access or Scheduled Task.

**Scope:** immutable fingerprint bodies named by live `fingerprint.json` pointers. The listing and the later GETs are separate requests, not one fence. A write that landed between them is outside this count. No film id, hash, body or credential is recorded here. The earlier local-contract report stays the record that production was not read for that check; this report is the later inventory.

**Used by:** [AIR-317](https://trello.com/c/jj45y0JW), PR #322. Not a production-write approval.

## Method

A private script called `createReadOnlyClient` and `readCredentials` from `scripts/r2-snapshot-export.mjs`. It refused to continue unless the account was the production account, the bucket was `iptv`, and the endpoint was not overridden. It listed `enrichment/` and then, eight at a time, read each `fingerprint.json`. For each pointer it rebuilt the body by dropping provenance (`generatedAt`, `invalidatedAt`, `fingerprintPromptVersion`, `produced`, `fields`, `previous`), hashed the canonical JSON of what remained except `fingerprintHash`, and compared that digest with the pointer. It counted a body key only when the listing already contained `enrichment/films/<id>/fingerprints/<hash>.json`. Present bodies were read and compared with the rebuilt value. The script printed counts and sorted field names. It did not print records.

## Counts

| Item | Count |
| --- | --- |
| Keys listed | 15018 |
| Pointers (`fingerprint.json`) | 2907 |
| Body present, canonical match, hash match | 544 |
| Body present and unequal, or hash mismatch, or unparsed | 0 |
| Body absent | 2363 |
| Absent pointer whose rebuilt hash still equals `fingerprintHash` | 2363 |
| Absent pointer with no hash, a bad hash, or an unparsed pointer | 0 |
| Absent pointer whose film has some other fingerprint body | 0 |
| Absent pointer whose film has a generation record | 0 |
| Films with a `fingerprint-generations/` key | 544 |

Field names on the 2363 absent pointers: 2359 have `confidence`, `execution`, `filmId`, `fingerprintHash`, `fingerprintSchemaVersion`, `generatedAt`, `invalidatedAt`, `moodLabels`, `plotMechanics`, `risks`, `sourceBasis`, `sourceRefs`, `strengths`. Those pointers predate the version writer ([ADR 0046](../../adr/0046-retire-fingerprint-version-objects-switch.md)). 4 also have `fingerprintPromptVersion`, `previous` and `produced`, and still have no body. Their rebuilt hash matches. This inventory does not invent a generation record for a pointer that has no `produced`.

## Verdict

**The 2363 missing bodies reconstruct from the pointer.** The read wrote nothing. It does not authorize `--materialize-fingerprints`, `--apply`, `--load`, or any other production write. A later create-only run is a separate approval.

**Limits.** Not a fenced snapshot. The 544 generation-record films and the 544 present bodies are equal counts; this report does not claim the two sets were compared key by key beyond `missingWithGeneration` 0. Queue length and leases were not part of this count.
