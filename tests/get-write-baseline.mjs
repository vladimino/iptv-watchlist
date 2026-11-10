// AIR-412: the registry behind tests/get-write-audit.mjs. Part one is the inventory (what the audit requests); part two is the baseline of the read routes that
// are KNOWN to write today, each with the exact effects per scenario, the card that removes it and why it exists. Fixing a writer means deleting its entry here:
// the audit then holds the route to "no effect" from that merge on. An entry nobody can reproduce fails the audit as stale.

// ---- inventory ----
// Every prefix (or by-path route) the dispatcher uses, with the GET samples that stand for the reads it serves. An empty list says the prefix serves no GET.
export const PREFIX_ROUTES={
 '/api/admin/':['/api/admin/overview','/api/admin/films?q=hot','/api/admin/people?queue=localization-missing','/api/admin/films?q=hot&queue=localization-missing','/api/admin/films/film:w1','/api/admin/people/person:director/one'],
 '/api/admin/films/':[],
 '/api/admin/people/':[],
 '/api/admin/health':['/api/admin/health'],
 '/api/admin/limbo':['/api/admin/limbo','/api/admin/limbo?cause=backoff&subsystem=prediction&kind=film&age=14&limit=5'],
 '/api/admin/posters':['/api/admin/posters','/api/admin/posters?limit=3&cursor=a'],
 '/api/admin/prediction-recovery':['/api/admin/prediction-recovery?film=w1'],
 '/api/admin/discovery-recovery':['/api/admin/discovery-recovery?key=hot%20film%7C2020'],
 '/api/admin/discovery-recovery/':['/api/admin/discovery-recovery/receipt?idempotencyKey=idem-000000000000001','/api/admin/discovery-recovery/identity-receipt?idempotencyKey=idem-000000000000001'],
 '/api/admin/letterboxd-archive/':['/api/admin/letterboxd-archive/apply'],
 '/api/admin/letterboxd-archive/identity-retry':[],
 '/api/catalog/watched':['/api/catalog/watched'],
 '/api/d1/':['/api/d1/status','/api/d1/persons','/api/d1/persons/review','/api/d1/films/w1','/api/d1/persons/actor/one','/api/d1/persons/actor/one/identity'],
 '/api/enrichment/':[],
 '/api/letterboxd/baseline/':['/api/letterboxd/baseline/validate'],
 '/api/migration-export/':['/api/migration-export/manifest'],
 '/api/ui/filter-presets/':['/api/ui/filter-presets/abc'],
};
// Reads the dispatcher serves through a pattern, not a prefix: the permanent catalog film lookup (AIR-387).
export const SAMPLES=['/api/catalog/film/42','/api/catalog/film/999','/api/catalog/film/abc','/api/catalog/film/0'];
// A query a route needs to reach its real code (without it the route answers 400).
export const QUERY={'/api/enrichment/history':'?filmId=w1','/api/letterboxd/diary':'?filmId=w1'};
// Static pages: assets, never storage.
export const PAGES=['/','/admin','/admin/health','/admin/limb','/admin/limbo','/admin/posters','/admin/letterboxd','/admin/actions','/events','/film/w1','/styles.css','/app.js','/admin.js','/return-home.js','/status-footer.js'];
// MCP: every tool in tools/list is one of these. A read tool is called with these arguments in every scenario; a write tool is never called (it writes by contract).
export const MCP_READ_TOOLS={
 probe_read:{},probe_echo:{arguments:{text:'audit'}},feature_flags:{},epg_status:{},epg_pipeline_status:{},enrichment_schema:{},enrichment_profile:{},enrichment_runner:{},enrichment_queue:{},enrichment_status:{},
 prediction_queue_overview:{},prediction_film_diagnostics:{arguments:{filmId:'w1'}},prediction_validate:{arguments:{prediction:{}}},prediction_pending:{},ratings_sync_status:{},
};
export const MCP_WRITE_TOOLS=['epg_sync_start','epg_sync_step','ratings_sync_start','ratings_sync_step','ratings_storage_migrate','prediction_start','prediction_next','prediction_submit','prediction_heartbeat','prediction_complete'];

// ---- baseline ----
// Every entry is a writer that exists today, found by the audit and not fixed by it (AIR-412 changes no behaviour). `effects` is the exact ordered effect list per scenario
// (a scenario that is not listed has none), `sql` the distinct statements the request ran, in order. `owner` is the card that removes the entry.
const PREDICTION_D1=['d1:UPDATE prediction_domain_authority','d1:UPDATE prediction_domain_cas','d1:INSERT INTO prediction_domain_intent','d1:DELETE FROM prediction_domain_intent','d1:UPDATE prediction_domain_cas'];
const PREDICTION_SQL=['UPDATE prediction_domain_authority SET generation=? WHERE id=? AND mode=? AND writes=? AND generation=?','UPDATE prediction_domain_cas SET ok=changes() WHERE id=?','INSERT INTO prediction_domain_intent (key, token, generation, body_sha256) VALUES (?,?,?,?)','DELETE FROM prediction_domain_intent WHERE key=? AND token=?'];
const STOP_PUTS=['put:enrichment/runs/run-stopped.json','put:enrichment/run-diagnostics/<ts>-run-stopped.json','put:events/items/<ts>-stop-run-stopped.json','put:enrichment/stop-events/run-stopped.json'];
const EXPIRED_PUTS=['put:enrichment/runs/run-expired.json','put:enrichment/run-diagnostics/<ts>-run-expired.json'];

export const BASELINE=[
 {id:'enrichment-runs-recovery',owner:'AIR-415',kind:'r2-d1-write',
  summary:'diagnosticHistory settles a run whose diagnostic row says running but whose lease expired: it rewrites the run record and the diagnostic row (R2); in D1 prediction-domain mode every saveJSON of a prediction object is a fenced D1 intent.',
  routes:['GET /api/enrichment/runs'],effects:{'r2-pending':EXPIRED_PUTS,'d1-pending':[...EXPIRED_PUTS,...PREDICTION_D1]},sql:{'d1-pending':PREDICTION_SQL}},
 {id:'enrichment-status-recovery',owner:'AIR-415, AIR-416',kind:'r2-d1-write',
  summary:'The status read runs recoverStopEvents (delivers an undelivered stop event: run record, diagnostic row, journal item, delivered flag), then diagnosticHistory (expired-lease settlement). Same effects through the MCP alias enrichment_status, which is annotated readOnlyHint false for this reason.',
  routes:['GET /api/enrichment/status'],
  effects:{'r2-pending':[...STOP_PUTS,...EXPIRED_PUTS],'d1-pending':[...STOP_PUTS,...EXPIRED_PUTS,...PREDICTION_D1,...PREDICTION_D1]},
  sql:{'d1-pending':PREDICTION_SQL}},
 {id:'events-recovery',owner:'AIR-416',kind:'r2-d1-write',
  summary:'The journal read runs recoverStopEvents before the page is read: an undelivered stop event is written into the journal and its record is marked delivered.',
  routes:['GET /api/events'],effects:{'r2-pending':STOP_PUTS,'d1-pending':[...STOP_PUTS,...PREDICTION_D1]},sql:{'d1-pending':PREDICTION_SQL}},
 {id:'tmdb-status-probe',owner:'(none: outbound read, documented)',kind:'outbound-read',
  summary:'The TMDB status route sends one GET to TMDB (movie 11) with the Worker secret. It changes nothing of ours and spends provider quota; it is listed so a second or a non-GET request cannot appear unnoticed.',
  routes:['GET /api/integrations/tmdb/status'],effects:Object.fromEntries(['r2','r2-pending','empty','d1','d1-mirror-missing','d1-mirror-stale','d1-held','d1-pending'].map(name=>[name,['fetch:GET https://api.themoviedb.org/3/movie/11']])),sql:{}},
];
export const MCP_BASELINE=[
 {id:'mcp-enrichment-status',owner:'AIR-415, AIR-416',kind:'r2-d1-write',
  summary:'enrichment_status is the same body as GET /api/enrichment/status and writes the same things; its annotation readOnlyHint false says so.',
  routes:['MCP enrichment_status'],effects:{'r2-pending':[...STOP_PUTS,...EXPIRED_PUTS],'d1-pending':[...STOP_PUTS,...EXPIRED_PUTS,...PREDICTION_D1,...PREDICTION_D1]},sql:{'d1-pending':PREDICTION_SQL}},
];
