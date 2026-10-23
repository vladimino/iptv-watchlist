-- AIR-49 schema v1. Structural storage only.
-- Not bound to Worker iptv. wrangler.jsonc has no D1 database, and this file is not applied to production.
-- R2 bucket iptv stays authoritative until a later, separate cutover.
-- Status strings are stored. Transition rules stay in the AIR-42, AIR-43, and AIR-48 domain code.

CREATE TABLE schema_contract (
 id INTEGER PRIMARY KEY CHECK (id=1),
 version INTEGER NOT NULL,
 note TEXT NOT NULL
) STRICT;
INSERT INTO schema_contract (id,version,note) VALUES (1,1,'Schema only. Not applied to production. R2 remains authoritative.');

-- Canonical Film and Person. An observation key is not a Film id.
CREATE TABLE film (
 id TEXT PRIMARY KEY CHECK (id LIKE 'film:%'),
 contract_version INTEGER NOT NULL,
 canonical_identity TEXT,
 original_title TEXT,
 updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE person (
 id TEXT PRIMARY KEY CHECK (id LIKE 'person:%'),
 role_id TEXT NOT NULL UNIQUE,
 contract_version INTEGER NOT NULL,
 updated_at TEXT NOT NULL
) STRICT;

-- Catalog fields from the watchlist film and parseFilm. film_dimension stays the lifecycle status.
CREATE TABLE film_metadata (
 film_id TEXT PRIMARY KEY REFERENCES film(id),
 schema_version INTEGER NOT NULL,
 year INTEGER,
 runtime INTEGER,
 synopsis TEXT,
 poster TEXT,
 url TEXT,
 genres_json TEXT NOT NULL,
 people_version INTEGER,
 payload_json TEXT NOT NULL,
 r2_key TEXT,
 content_sha256 TEXT,
 updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE film_person_credit (
 film_id TEXT NOT NULL REFERENCES film(id),
 person_id TEXT NOT NULL REFERENCES person(id),
 role TEXT NOT NULL CHECK (role IN ('director','actor')),
 ordinal INTEGER NOT NULL,
 PRIMARY KEY (film_id,person_id,role)
) STRICT;
CREATE UNIQUE INDEX film_person_credit_order ON film_person_credit(film_id,role,ordinal);
CREATE INDEX film_person_credit_by_person ON film_person_credit(person_id,role,film_id);

CREATE TABLE film_external_id (
 film_id TEXT NOT NULL REFERENCES film(id),
 scheme TEXT NOT NULL,
 value TEXT NOT NULL,
 trusted INTEGER NOT NULL CHECK (trusted IN (0,1)),
 conflicting INTEGER NOT NULL CHECK (conflicting IN (0,1)),
 provenance_json TEXT,
 PRIMARY KEY (film_id,scheme,value)
) STRICT;
CREATE UNIQUE INDEX film_external_id_one_trusted ON film_external_id(scheme,value) WHERE trusted=1 AND conflicting=0;

CREATE TABLE person_external_id (
 person_id TEXT NOT NULL REFERENCES person(id),
 scheme TEXT NOT NULL,
 value TEXT NOT NULL,
 trusted INTEGER NOT NULL CHECK (trusted IN (0,1)),
 conflicting INTEGER NOT NULL CHECK (conflicting IN (0,1)),
 provenance_json TEXT,
 PRIMARY KEY (person_id,scheme,value)
) STRICT;

-- from_id is the retired id. It is not a second Film.
CREATE TABLE film_redirect (
 from_id TEXT PRIMARY KEY CHECK (from_id LIKE 'film:%'),
 to_film_id TEXT NOT NULL REFERENCES film(id),
 at TEXT NOT NULL
) STRICT;

CREATE TABLE film_alias (
 film_id TEXT NOT NULL REFERENCES film(id),
 kind TEXT NOT NULL,
 value TEXT NOT NULL,
 provenance_json TEXT,
 PRIMARY KEY (film_id,kind,value)
) STRICT;

CREATE TABLE person_alias (
 person_id TEXT NOT NULL REFERENCES person(id),
 kind TEXT NOT NULL,
 value TEXT NOT NULL,
 provenance_json TEXT,
 PRIMARY KEY (person_id,kind,value)
) STRICT;

CREATE TABLE localization_conflict (
 id TEXT PRIMARY KEY,
 entity_kind TEXT NOT NULL CHECK (entity_kind IN ('film','person')),
 entity_id TEXT NOT NULL,
 value TEXT,
 source TEXT,
 provenance_json TEXT,
 authority TEXT,
 reason TEXT NOT NULL,
 at TEXT NOT NULL
) STRICT;

-- Stored dimension state. The domain module still decides which transition is legal.
CREATE TABLE film_dimension (
 film_id TEXT NOT NULL REFERENCES film(id),
 dimension TEXT NOT NULL CHECK (dimension IN ('identity','metadata','localization','fingerprint','prediction')),
 status TEXT NOT NULL,
 source TEXT,
 source_version TEXT,
 provenance_json TEXT,
 value TEXT,
 authority TEXT,
 last_error TEXT,
 failure_reason TEXT,
 retry_at TEXT,
 attempts INTEGER NOT NULL DEFAULT 0,
 next_action TEXT,
 updated_at TEXT NOT NULL,
 PRIMARY KEY (film_id,dimension)
) STRICT;

CREATE TABLE person_dimension (
 person_id TEXT NOT NULL REFERENCES person(id),
 dimension TEXT NOT NULL CHECK (dimension IN ('identity','localization')),
 status TEXT NOT NULL,
 source TEXT,
 source_version TEXT,
 provenance_json TEXT,
 value TEXT,
 authority TEXT,
 last_error TEXT,
 failure_reason TEXT,
 retry_at TEXT,
 attempts INTEGER NOT NULL DEFAULT 0,
 next_action TEXT,
 updated_at TEXT NOT NULL,
 PRIMARY KEY (person_id,dimension)
) STRICT;

CREATE TABLE watchlist_film (
 film_id TEXT PRIMARY KEY REFERENCES film(id),
 updated_at TEXT NOT NULL
) STRICT;

-- One generation is current. Older rows stay, including rows whose phase is still published.
CREATE TABLE programme_generation (
 programme_run_id TEXT PRIMARY KEY,
 phase TEXT NOT NULL CHECK (phase IN ('published','withheld')),
 published_at TEXT
) STRICT;

CREATE TABLE published_generation (
 id INTEGER PRIMARY KEY CHECK (id=1),
 programme_run_id TEXT NOT NULL REFERENCES programme_generation(programme_run_id)
) STRICT;

-- Membership with no film_show rows is an explicit empty list.
CREATE TABLE film_generation (
 programme_run_id TEXT NOT NULL REFERENCES programme_generation(programme_run_id),
 film_id TEXT NOT NULL REFERENCES film(id),
 PRIMARY KEY (programme_run_id,film_id)
) STRICT;

CREATE TABLE film_show (
 programme_run_id TEXT NOT NULL,
 film_id TEXT NOT NULL,
 channel_id TEXT NOT NULL,
 channel TEXT,
 start_ms INTEGER NOT NULL,
 end_ms INTEGER,
 epg_title TEXT,
 basis TEXT,
 match_reason TEXT,
 PRIMARY KEY (programme_run_id,film_id,channel_id,start_ms),
 FOREIGN KEY (programme_run_id,film_id) REFERENCES film_generation(programme_run_id,film_id)
) STRICT;
CREATE INDEX film_show_by_generation ON film_show(programme_run_id,start_ms);

-- Historical fact. It does not make a film available.
CREATE TABLE film_epg_last_airing (
 film_id TEXT PRIMARY KEY REFERENCES film(id),
 airing_ms INTEGER NOT NULL,
 programme_run_id TEXT
) STRICT;

CREATE VIEW published_film_show AS
SELECT s.programme_run_id,s.film_id,s.channel_id,s.channel,s.start_ms,s.end_ms,s.epg_title,s.basis,s.match_reason
FROM film_show s
JOIN published_generation p ON p.id=1 AND p.programme_run_id=s.programme_run_id
JOIN programme_generation g ON g.programme_run_id=s.programme_run_id AND g.phase='published';

-- Candidate ledger. The key is an observation, never a Film id.
-- observation_json on this row is the latest projection. A generation keeps its own copy.
CREATE TABLE candidate (
 observation_key TEXT PRIMARY KEY CHECK (observation_key NOT LIKE 'film:%' AND observation_key NOT LIKE 'person:%'),
 title TEXT NOT NULL,
 normalized_title TEXT NOT NULL,
 year INTEGER,
 raw_titles_json TEXT NOT NULL,
 durations_json TEXT NOT NULL,
 description TEXT,
 first_airing_ms INTEGER,
 last_airing_ms INTEGER,
 airings INTEGER,
 confirmed_tmdb_id TEXT,
 observation_schema_version INTEGER NOT NULL,
 observation_json TEXT NOT NULL,
 activity TEXT,
 last_seen_at TEXT,
 last_seen_programme_run_id TEXT,
 seen_in_latest INTEGER NOT NULL CHECK (seen_in_latest IN (0,1)),
 attempts INTEGER NOT NULL DEFAULT 0,
 last_attempt_at TEXT,
 retry_at TEXT,
 terminal_reason TEXT,
 evidence_key TEXT
) STRICT;
CREATE INDEX candidate_retry ON candidate(retry_at) WHERE terminal_reason IS NULL;

-- Immutable observation for this generation. Updating candidate does not change this row.
CREATE TABLE candidate_generation (
 programme_run_id TEXT NOT NULL REFERENCES programme_generation(programme_run_id),
 observation_key TEXT NOT NULL REFERENCES candidate(observation_key),
 observation_schema_version INTEGER NOT NULL,
 observation_json TEXT NOT NULL,
 evidence_key TEXT NOT NULL,
 PRIMARY KEY (programme_run_id,observation_key)
) STRICT;

CREATE TABLE candidate_show (
 programme_run_id TEXT NOT NULL,
 observation_key TEXT NOT NULL,
 channel_id TEXT NOT NULL,
 channel TEXT,
 start_ms INTEGER NOT NULL,
 end_ms INTEGER,
 epg_title TEXT,
 PRIMARY KEY (programme_run_id,observation_key,channel_id,start_ms),
 FOREIGN KEY (programme_run_id,observation_key) REFERENCES candidate_generation(programme_run_id,observation_key)
) STRICT;

-- AIR-48 decision. A score_result row is not this record, and this record does not require one.
CREATE TABLE candidate_decision (
 observation_key TEXT PRIMARY KEY REFERENCES candidate(observation_key),
 status TEXT NOT NULL,
 reason TEXT,
 catalog_film_id TEXT,
 film_id TEXT REFERENCES film(id),
 tmdb_id TEXT,
 canonical_identity TEXT,
 identity_source TEXT,
 checked_at TEXT NOT NULL,
 evidence_key TEXT,
 attempts INTEGER NOT NULL DEFAULT 0,
 last_attempt_at TEXT,
 retry_at TEXT,
 terminal_reason TEXT,
 provenance_json TEXT
) STRICT;

CREATE TABLE candidate_decision_history (
 observation_key TEXT NOT NULL REFERENCES candidate(observation_key),
 checked_at TEXT NOT NULL,
 status TEXT NOT NULL,
 reason TEXT,
 catalog_film_id TEXT,
 film_id TEXT REFERENCES film(id),
 tmdb_id TEXT,
 canonical_identity TEXT,
 identity_source TEXT,
 evidence_key TEXT,
 attempts INTEGER NOT NULL DEFAULT 0,
 last_attempt_at TEXT,
 retry_at TEXT,
 terminal_reason TEXT,
 provenance_json TEXT,
 replaced_at TEXT NOT NULL,
 PRIMARY KEY (observation_key,checked_at)
) STRICT;

-- Score, detail card, and gate outcome. accepted_tmdb_id does not reference film.
CREATE TABLE score_result (
 id TEXT PRIMARY KEY,
 observation_key TEXT NOT NULL REFERENCES candidate(observation_key),
 programme_run_id TEXT NOT NULL REFERENCES programme_generation(programme_run_id),
 scorer_version TEXT NOT NULL,
 status TEXT NOT NULL,
 reason TEXT,
 confidence REAL,
 score REAL,
 accepted_tmdb_id TEXT,
 gate_outcome TEXT,
 gate_reason TEXT,
 provenance_json TEXT,
 created_at TEXT NOT NULL,
 UNIQUE (observation_key,programme_run_id,scorer_version)
) STRICT;
CREATE INDEX score_result_by_observation ON score_result(observation_key,programme_run_id);

CREATE TABLE score_considered (
 score_id TEXT NOT NULL REFERENCES score_result(id),
 ordinal INTEGER NOT NULL,
 tmdb_id TEXT NOT NULL,
 trusted INTEGER NOT NULL CHECK (trusted IN (0,1)),
 year INTEGER,
 runtime INTEGER,
 PRIMARY KEY (score_id,ordinal)
) STRICT;

CREATE TABLE score_detail (
 score_id TEXT PRIMARY KEY REFERENCES score_result(id),
 movie_id TEXT NOT NULL,
 runtime INTEGER,
 release_year INTEGER,
 matched_title TEXT,
 fetched_at TEXT NOT NULL,
 r2_key TEXT,
 content_sha256 TEXT
) STRICT;

-- Enrichment. The large body stays an immutable R2 object addressed by hash.
CREATE TABLE fingerprint_payload (
 film_id TEXT PRIMARY KEY REFERENCES film(id),
 schema_version INTEGER NOT NULL,
 fingerprint_hash TEXT NOT NULL,
 generated_at TEXT,
 invalidated_at TEXT,
 r2_key TEXT NOT NULL,
 content_sha256 TEXT NOT NULL
) STRICT;

CREATE TABLE profile_version (
 version INTEGER PRIMARY KEY,
 profile_hash TEXT NOT NULL,
 created_at TEXT NOT NULL,
 r2_key TEXT NOT NULL,
 content_sha256 TEXT NOT NULL
) STRICT;

CREATE TABLE prediction_current (
 film_id TEXT PRIMARY KEY REFERENCES film(id),
 taste_profile_version INTEGER REFERENCES profile_version(version),
 taste_profile_hash TEXT,
 fingerprint_hash TEXT,
 fingerprint_schema_version INTEGER,
 prediction_prompt_version INTEGER,
 predicted_rating REAL,
 r2_key TEXT,
 content_sha256 TEXT,
 updated_at TEXT NOT NULL
) STRICT;

-- payload_json is the full former prediction. r2_key addresses that immutable body, not predictions.json.
CREATE TABLE prediction_history (
 film_id TEXT NOT NULL REFERENCES film(id),
 replaced_at TEXT NOT NULL,
 predicted_rating REAL,
 taste_profile_version INTEGER,
 fingerprint_hash TEXT,
 payload_json TEXT NOT NULL,
 r2_key TEXT NOT NULL,
 content_sha256 TEXT NOT NULL,
 source TEXT,
 PRIMARY KEY (film_id,replaced_at)
) STRICT;

CREATE TABLE actual_rating (
 film_id TEXT PRIMARY KEY REFERENCES film(id),
 rating REAL NOT NULL,
 source TEXT NOT NULL,
 recorded_at TEXT NOT NULL
) STRICT;

-- Future owner-review records. No workflow writes them from this schema.
CREATE TABLE identity_assertion (
 id TEXT PRIMARY KEY,
 observation_key TEXT NOT NULL REFERENCES candidate(observation_key),
 programme_run_id TEXT NOT NULL REFERENCES programme_generation(programme_run_id),
 film_id TEXT REFERENCES film(id),
 tmdb_id TEXT,
 authority TEXT NOT NULL,
 revoked_at TEXT,
 created_at TEXT NOT NULL
) STRICT;

CREATE TABLE identity_rule_version (
 rule_id TEXT NOT NULL,
 version INTEGER NOT NULL,
 confidence TEXT,
 predicates_json TEXT NOT NULL,
 created_at TEXT NOT NULL,
 PRIMARY KEY (rule_id,version)
) STRICT;

CREATE TABLE identity_application (
 id TEXT PRIMARY KEY,
 observation_key TEXT NOT NULL REFERENCES candidate(observation_key),
 programme_run_id TEXT NOT NULL REFERENCES programme_generation(programme_run_id),
 assertion_id TEXT REFERENCES identity_assertion(id),
 rule_id TEXT,
 rule_version INTEGER,
 created_at TEXT NOT NULL,
 FOREIGN KEY (rule_id,rule_version) REFERENCES identity_rule_version(rule_id,version)
) STRICT;

-- One source object checksum maps to the same target once. Re-import is a duplicate.
CREATE TABLE import_receipt (
 source_key TEXT NOT NULL,
 source_sha256 TEXT NOT NULL,
 target_table TEXT NOT NULL,
 target_id TEXT NOT NULL,
 imported_at TEXT NOT NULL,
 PRIMARY KEY (source_key,source_sha256,target_table,target_id)
) STRICT;
