-- AIR-453 / ADR 0121. The identity record of the EPG diagnostic database. NOT part of the production migration chain (`migrations/`), never
-- applied by the deploy and never applied to the production database `iptv`: it is the schema contract of a separate diagnostic D1 that the owner
-- provisions in AIR-456, which holds the production chain of migrations (schema only, so the real seal path, the EPG step lease and the Discovery
-- and published-EPG fences find their tables) followed by this file. `src/epg-diagnostic.js` refuses every write until this row, and the
-- `diagnostic/identity.json` object of the diagnostic bucket, name the same resource.
CREATE TABLE epg_diagnostic_identity (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  domain TEXT NOT NULL CHECK (domain = 'epg-diagnostic'),
  resource_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
