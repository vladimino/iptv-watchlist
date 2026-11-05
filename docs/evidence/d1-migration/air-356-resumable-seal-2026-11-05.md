# AIR-356 resumable ledger seal: offline evidence

**Captured:** 2026-11-05 (UTC). **Scope:** repository tests and a local SQLite stand-in of D1 (`tests/d1-standin.mjs`). No production read or write, no Cloudflare call.

## Method

`tests/discovery-seal-resume.mjs` drives the authority state machine (`sealBegin`, `sealWrite`, `sealArchive`); `tests/discovery-seal-publish.mjs` drives the Worker steps with stubs for `PublishedEpg` and ratings completion. With `SEAL_FULL=1` the first test seals 20,064 observations of two shows each.

## Results

- Cursor and rows agree after a kill before or after any batch; the same job never flips the previous ledger twice; an unknown batch outcome, a second writer, a changed generation and an expired lease are refused by the cursor or the fence and write nothing.
- The incident shape (36,671 retiring plus 328 active rows) resumes without losing the 328 rows and without duplicating active rows; `0012` refuses a schema v10 database.
- Byte-offset reads of a document with Cyrillic and multibyte text resume correctly across cancelled steps; a document changed under the job is refused.
- Full volume on the local stand-in: 669 batches, about 30 observations per batch, about 20.8 s. At about 1 s per production D1 batch this would be about 30–35 bounded steps (an **estimate, not measured**).

## Limits

The production D1 round trip, the Worker CPU of a step and real R2 range reads were not measured. The statement cap stays 40. The Mermaid change in the EPG diagram needs the owner's visual check on GitHub. Nothing here authorizes applying `0012` or recovering the production run.
