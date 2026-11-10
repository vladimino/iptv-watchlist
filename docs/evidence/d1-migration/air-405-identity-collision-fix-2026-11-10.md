# D1 projector: the `identity_collision` of a Letterboxd Film and its TMDB twin (fix, offline proof)

**Captured:** 2026-11-10 UTC. Offline tests (the real projector, repository and migrations over a sqlite stand-in of D1 and a memory R2), and one read-only D1 `SELECT` over `discovery_admission` for the three Films of [AIR-404](air-404-identity-collision-rca-2026-11-10.md) (their TMDB ids only). No manual projector, Discovery or EPG run, no flag, Task, cron, lease or budget change, no production write, no live repair.
**Scope:** [AIR-405](https://trello.com/c/7uyOEMXx). The ordering defect of the projector's per-entity Film write found by AIR-404. It does not touch the grouped write path, the L1 wall budget, Discovery, EPG, ratings or R2 authority, and it adds no identity rule.
**Verdict:** **FIXED OFFLINE; RUNTIME NOT YET OBSERVED.** A Film that carries redirects is now written together with the links that retire the Films holding its trusted ids, in one transaction, released before the survivor's ids are inserted, and only those owners are accepted. The new tests fail on the previous code (the Film is refused on every run) and pass on this change. Whether the three production Films are now written is not known: no natural run has reached them since the deploy. The case where the view does not link the owner (S3 of AIR-404) is still refused (fail closed), by design.
**Used by:** [AIR-404](air-404-identity-collision-rca-2026-11-10.md), [ADR 0106](../../adr/0106-bulk-projector-write-path.md) (L1 stop gate).

## The change

- `src/canonical-repository.js`: `projectFilm` accepts `redirects`. It plans each redirect as `projectLink` does (target is the survivor; no stored redirect to another target; the retired Film has no generation and no EPG history), collects the owners whose redirect is not stored yet, passes them to `planFilm` as the Films the write retires, deletes their external ids before the Film's own are inserted, then writes the Film. `planFilm` takes a list of retired Films instead of one id; `planLink` merges the one it was given with any others the caller names, so a Film with several redirects is accepted by each link.
- `src/d1-enrichment.js` (per-entity path only, inside the existing fenced transaction): passes the Film's redirects to `projectFilm` and the list of retired Films to each `projectLink`. Query order of the diff, budget, fencing, lease, window and the grouped path are unchanged; a Film with redirects still never joins a group.
- `adoptRetired` (shared with `applyLink`): found by the review of this change. The credits only a retired Film holds were shifted one by one when their own ordinal was taken; against the survivor as it was when the statement began, a shifted credit could land on the ordinal of an unshifted one of the same Film and the unique index (`film_id, role, ordinal`) refused the whole write (reproduced in SQLite: survivor ordinal 0, retired ordinals 0 and 1). For a role with any taken ordinal every adopted credit now moves by the same amount, after the highest survivor ordinal, so their order is kept and none meets another; a role with none keeps its ordinals. In the projector's own flow the view already carries the credits of both Films in its roster, so little is adopted; the case needs D1-only credits on a retired Film.
- The unique index of trusted ids, `planFilm`'s check and the refusal for an owner no redirect names are unchanged. The refusal message is still `identity_collision`, so after this change an `identity_collision` means an owner this write does not retire (a real ambiguity), and a retired Film with history is refused with its own reason.

## Why the old order failed

`projectFilm` planned the Film before `projectLink` released the Film it retires: the owner `film:tmdb:<id>` still held the trusted TMDB id, so the Film was refused and the link was never reached. Even with the owner accepted, the survivor's insert would have run before the owner's delete inside the batch and hit the unique index. Both orders are now fixed together.

## Offline proof

| Test | What it shows |
| --- | --- |
| `tests/d1-enrichment-identity-collision.mjs` S1 | The catalog Film is projected, then the Letterboxd Film arrives with the catalog record still in the view: one run writes it with a redirect from the catalog Film, the trusted TMDB id belongs to the survivor only, membership moves, the credit and the alias of the retired Film move without a duplicate, no credit lacks a Film or a Person; two further runs change nothing and report no error; a deleted checkpoint of the survivor is rewritten without a collision and the state is the same |
| same, S2, S4 (controls) | Both Films in one first run, or the Letterboxd Film first: linked as before |
| same, S3 | The catalog no longer lists the Film (no link in the view): still refused with `identity_collision`, the owner untouched (fail closed) |
| same, S5 | An unrelated Film owns the trusted id: refused, nothing written, the owner kept |
| same, S6 | The retired Film has EPG history: the whole Film write is refused with its own reason; no Film fact changes |
| `tests/canonical-repository-projected-link.mjs` | At the repository with one adapter shared by the repository and the transaction: one redirect (owner refused without the redirect, accepted with it); two redirects holding different trusted ids (refused when only one is named, nothing written; both retired when both are named); an unrelated owner; EPG history; a redirect to another Film; a repeated write changes nothing; a statement that fails after the Film write leaves nothing, the release included; two retiring Films that each hold credits (some sharing ordinals with the survivor's), an alias and a membership the incoming roster does not list: every credit, both aliases and the membership are on the survivor, no duplicate, no shared ordinal in a role, no dangling credit, and two repeated writes change nothing (this case failed on the unique index before the `adoptRetired` change) |

Checked in the first tests: `film_external_id`, `film_redirect`, `watchlist_film`, `film_person_credit`, `film_alias` and the Film checkpoints of `projection_state`.

## The three production Films

One read-only `SELECT` over `discovery_admission` shows that the catalog record of each of the three TMDB ids is `current` in the D1 catalog. That is all it shows: the catalog twin is in the catalog the projector reads. It does **not** show that the computed lifecycle view contains the link (the lifecycle reader produces it only when both Films carry the same trusted TMDB id and it has linked them), and nothing here reads the view itself. Whether each of the three Films is the S1 case this change fixes or the S3 case that stays refused is therefore likely but not established; a natural run that reaches them decides it.

## Not yet observed, and limits

- **This change is not deployed yet, so no natural run can have reached the three Films with it.** After the deploy, an absence of the error in a run that did not reach them is not a result. The acceptance is: a natural run that reaches them writes each Film (no `identity_collision`), the catalog twin becomes a redirect to it, the membership and the trusted ids are on the survivor. If it does not, the reason is read from the run's error list and reported.
- **S3 is not solved.** A Letterboxd Film whose trusted id is held by a Film the view does not link stays refused. Retiring that Film would delete D1-only facts (for example fingerprint and prediction dimensions) that nothing in the view carries over. A rule for it is a material identity decision for the owner; none is made here.
- **No live repair.** Rows already written in D1 are not changed; the three Films are written by the next run that reaches them, if the view links them.
- The three Films are also affected by the budget: a run that stops on its wall budget before reaching them does not write them.
