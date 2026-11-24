# ADR 0210: Canonical Film identity keeps a source-aware evidence ledger beside its claims

**Status:** Proposed (no owner decision on this record; every choice below awaits review and an explicit, ADR-specific Product Owner decision)  
**Original decision date:** not decided  
**Recorded at:** 2026-11-24  
**Approval source:** not decided. Requested as the companion of [ADR 0207](0207-letterboxd-admissions-coordinated-in-d1-only.md) by the owner's disposition 5C on [PR #975](https://github.com/vladimino/iptv-watchlist/pull/975#issuecomment-7131137347): "источник источнику рознь, нужно отличать доказательства для записи в программе с названием без года от фильма с полноценным LID (из архива, оценок или watchlist)". That disposition chose the direction (a separate evidence model); it does not accept this design.  
**Related work:**
- [AIR-555](https://trello.com/c/JPgjoBzK), under [AIR-275](https://trello.com/c/4x7hH0gI).
- [ADR 0207](0207-letterboxd-admissions-coordinated-in-d1-only.md) (Proposed) depends on this record for the provenance of new admissions.

**Supersedes:** None. It amends nothing by itself: decision 6 lists the optional amendments, each one a separate owner choice.  
**Superseded by:** None

## Context

### What exists (main, 24 Nov 2026)

Identity evidence for canonical Films is spread over about eight D1 tables, JSON payloads and documents. There is no shared model.

**The canonical decision.** It is the trusted, non-conflicting `film_external_id` row (unique per `(scheme, value)`). Its `provenance_json` is free-form, and on some legacy rows it is null.

**Duplicated identity state.**
- **Copies of the identity.** `film.canonical_identity` and the `identity` row of `film_dimension` repeat the claim.
- **Four records of one rated admission.** `film_rated_admission`, the `letterboxd_short_code` alias, the claim provenance (`letterboxd_rated_admission`), and the R2 `verified-films.json`.

**Discovery evidence.** It lives in the Discovery domain:
- observations (`discovery_observation`, nullable `year`, `confirmed_tmdb_id`);
- decisions (`discovery_decision`, `identitySource` in its payload: `tmdb_detail`, `owner`, `known_epg_alias`);
- admissions;
- owner intents.

Every Discovery admission reaches the canonical claim as the same `{source:'discovery', verified:true}`.

**Inferred LID→TMDB links (ADR 0104, 0105).** They are marked only on the Ratings fact records (`identity`, `inferredPairs`), which the ADR 0184 planner reads as negative proof. In D1 the resulting admission is a trusted `tmdb` claim that looks the same as a verified one.

**Diary and Watchlist LIDs.** Both use the same page check (ADR 0166, generalized by ADR 0186 decision 5). They write the same `diary_page` receipt, and nothing tells them apart in D1.

**Rated archive proof.** ADR 0170's inventory uses an exact `archive_sha256` + `source_code` join on `film_rated_admission`.

**Not persisted anywhere:**
- the reason behind a claim (observation, decision or proof route);
- ADR 0184 verdicts (`not_proved`, `conflict`);
- removals and trust changes of external ids;
- a reconcile of a canonical claim after an ADR 0178 `identity_revoke`.

**The unused 0001 owner-assertion tables.** `identity_assertion`, `identity_application` and `identity_rule_version` exist only offline; no runtime writer uses them.

### Why the source matters

The sources of identity evidence differ in strength and in what they identify:

| Source | What it identifies | Strength for `tmdb:movie` |
| --- | --- | --- |
| (a) EPG programme title without year | nothing by itself | a hint; never admits or proves |
| (b) EPG title with year, runtime and movie provenance, or a known EPG alias | a candidate movie | candidate; Discovery verification still needed |
| (b′) Discovery `tmdb_detail` verification | a movie | verified movie identity (ADR 0010) |
| (c) Rated archive short code | a Letterboxd entity (short code, not a lid) | none until the page check verifies it (ADR 0087, 0090) |
| (d) Ratings or Diary LID | a Letterboxd entity | none by itself |
| (e) Watchlist LID | a Letterboxd entity | none by itself |
| (f) Inferred LID→TMDB link (title and year search) | a guess | **negative**: never a proof (ADR 0184) |
| (g) Page-verified pair (page, single `data-tmdb-id`, TMDB title and year agree) | the pair | verified pair (ADR 0166, 0087, 0090) |
| (h) Ratings alias bridge claim (ADR 0184) | the pair | proved claim |
| (i) Owner assignment, correction or revoke | the pair or its negation | owner authority |

The owner's point: a LID identifies a Letterboxd entity. It is not automatically a verified TMDB match, and it must not be weighed like a title-only programme row.

## Decision (proposed)

### 1. One append-only evidence ledger in the Film/Person domain

- **The table.** A new D1 table `film_identity_evidence`, owned by the Film/Person authority (the same marker and fence as `film_external_id`), records **why** a canonical identity statement was made.
- **What it is not.** It is **not** a second canonical Film, claim or admission table:
  - the canonical decision stays the trusted `film_external_id` row;
  - admission stays `film_rated_admission` (ADR 0207);
  - Discovery keeps its observation and decision tables as its own domain evidence (ADR 0085).

Minimum schema:

| Column | Meaning |
| --- | --- |
| `id` | integer key |
| `film_id` | the Film the evidence is about. A redirect is followed at write time; rows keep the id they were written for |
| `scheme`, `value` | the external id the evidence speaks about (`tmdb`, `letterboxd`, `letterboxd_short_code`, `tmdb_tv`) |
| `stance` | `supports` or `refutes` |
| `strength` | one of `hint`, `candidate`, `verified`, `proved`, `owner`, `negative` (decision 2) |
| `source_kind` | one of `epg_title`, `epg_title_year`, `discovery_detail`, `archive_short_code`, `ratings_lid`, `watchlist_lid`, `inferred_link`, `page_verified`, `ratings_alias_bridge`, `owner` |
| `source_ref` | the stable reference of the source: an archive digest, an evidence digest, a Discovery observation key, a scan id or a receipt request id. Never a payload, never a private value beyond the ids already in the canonical tables |
| `observed_at` | when the source said it |
| `recorded_at`, `request_id` | the write and its receipt |
| `supersedes_id` | the row this one replaces, if any |

**Append-only.** A trigger refuses UPDATE and DELETE. The current view per `(film_id, scheme, value)` is the latest non-superseded row of each `source_kind`.

**Writers.** Evidence rows are written **in the same fenced batch** as the canonical effect they justify. An evidence row without its canonical effect, or the reverse, cannot exist.

### 2. Strength vocabulary and how it combines

- **`hint`** (`epg_title`): never admits, never proves, never corroborates a `verified`.
- **`candidate`** (`epg_title_year`, `archive_short_code`, `ratings_lid`, `watchlist_lid`).
  - A Letterboxd id, a short code or a titled programme row with a year is a candidate for its own scheme only.
  - A LID **identifies a Letterboxd entity**. It is never a candidate for `tmdb`.
- **`verified`** (`discovery_detail`, `page_verified`): one independent verification is enough to admit a Film by that movie id.
- **`proved`** (`ratings_alias_bridge`): the ADR 0184 claim proof for the `letterboxd` scheme.
- **`owner`**: an owner assignment (`supports`) or a correction or revoke (`refutes`). It outranks every automatic row.
- **`negative`** (`inferred_link`, stance `supports` but negative strength): records that the pair was linked by a title and year guess.
  - It **never** counts as proof.
  - While it is the only support of a `letterboxd` pair, it blocks a claim, as ADR 0184 already does from the Ratings marks.

**Corroboration.** Rows of **independent source kinds** can corroborate each other for review and ranking. Corroboration never raises a `hint` or a `negative` to `verified`. A verification needs its own `verified` row.

**Supersession and revocation.**
- A newer row of the same `source_kind` supersedes the older one.
- An owner `refutes` row, a retirement or a merge records the refutation.
- Nothing is deleted; history stays readable.

### 3. Which writers record evidence

**Mandatory for AIR-275**, with [ADR 0207](0207-letterboxd-admissions-coordinated-in-d1-only.md), at its mode `d1`:
- each new-path admission writes its row in the admission batch:
  - inferred import: `inferred_link`, `negative`;
  - Diary: `page_verified`, with a `ratings_lid` candidate;
  - Watchlist admission: `page_verified`, with a `watchlist_lid` candidate;
  - rated archive: `page_verified`, with an `archive_short_code` candidate.
- This replaces the `d1:<kind>` `receipt_key` marker that ADR 0207 had proposed, so the kind is recorded once, not in two models.

**Longer-term catalog work**, separate cards and not required for AIR-275:
- Discovery admission (`discovery_detail`, or `epg_title_year`/`epg_title` hints from observations);
- the ADR 0184 claim unit (`ratings_alias_bridge`);
- owner identity actions (`owner`, including the claim side of an ADR 0178 revoke);
- retirement and merge (`refutes` and supersession).

### 4. Readers

- **Nothing changes its decision when this ledger appears.**
  - ADR 0184 keeps reading the Ratings marks.
  - ADR 0170 keeps its exact archive-and-code join.
  - The catalog and Discovery keep their reads.
- **A later reader switch is its own card**, after the writers of decision 3 have produced a complete history (decision 6). Examples: the claim planner reading `negative` rows, the inventory joining on per-archive `page_verified` rows.

### 5. Backfill

- **(i) No backfill (recommended for AIR-275).** Evidence exists from the activation of each writer. Rows admitted before it have no evidence row, and readers treat that as "legacy, unknown source".
- **(ii) Bounded backfill of the 714 existing admissions**, a separate owner L3 decision.
  - The source kind comes from the frozen R2 object and the Ratings marks: 703 `inferred_link`/`negative`, 6 `page_verified` (Diary or Watchlist, not separable), 5 `page_verified` from the rated archive.
  - It is a fenced, receipted import with a dry run.
  - It gives the global catalog a clean start, but it is not needed to retire the R2 coordination.
- **(iii) Backfill of the 415 claims and of Discovery admissions:** not proposed. It needs reconstruction from Discovery decision payloads and is left to a later decision.

### 6. Optional amendments (each a separate owner choice, not decided here)

- **ADR 0170:** the inventory may join on a `page_verified` row with the candidate's archive digest. That resolves the keep-first corner case of ADR 0207 (a later archive that verifies the same pair) without weakening the exact proof.
- **ADR 0184:** the claim planner may read `negative` rows in addition to the Ratings marks. The Ratings marks stay authoritative until the owner decides otherwise.
- **The unused 0001 owner-assertion tables:** retire them (a cleanup decision) instead of reviving them, so there is one evidence model.

## Alternatives considered

- **No ledger; extend `provenance_json` on `film_external_id`.**
  - For: no new table.
  - Against: one mutable JSON per claim cannot hold several sources, refutations or history, and it is overwritten by merges.
- **Identity-kind column on `film_rated_admission`** (ADR 0207 option B′).
  - For: small.
  - Against: it covers admissions only. Discovery, claims and owner actions would need their own fields, which is the duplication this record avoids.
- **Revive the offline 0001 `identity_assertion` tables.**
  - For: tables that already exist.
  - Against: they were designed for the offline EPG repository, have no runtime writer, and model owner rules rather than source evidence.
- **Store evidence in the Discovery domain.**
  - For: Discovery already has observations.
  - Against: Letterboxd sources are not Discovery observations, and the Film/Person domain owns the canonical claim the evidence justifies.

## Consequences

- One place that answers "why does this Film carry this id, from which source, how strong". It is reusable by every catalog entry route, and the global catalog can build on it.
- An additive migration (one table, its triggers and indexes) and a writer helper used inside existing fenced batches. Each batch gains one or two statements.
- No reader changes its behaviour until a separately approved switch. The new table cannot break a current decision.
- Growth: one to three rows per admission or claim event. It is append-only like the receipt table. Retention is a later owner decision, as for receipts.

## Recovery and migration boundary

- Before any writer uses it, the table can be dropped by a forward migration.
- Once writers append to it, rows are history and are never deleted. A wrong row is refuted by a newer row.
- Backfill (5 ii) and reader switches (6) are separate owner decisions.
- This ADR, even when Accepted, authorizes no migration apply, write or backfill.

## Evidence

- The AIR-555 audit (PR #972) and its review.
- The survey of existing identity evidence made for this record (24 Nov 2026), whose findings are summarized in the Context.
- Production L0 read, 24 Nov 2026 12:21 UTC: 714 admissions, no identity-kind column. Inferred provenance is on the Ratings records (703/703).

## Follow-ups

On acceptance: the cards listed in the ADR 0207 delivery graph:
- the evidence core, a prerequisite of the admission coordination;
- the longer-term writers;
- the optional backfill;
- each reader amendment.
