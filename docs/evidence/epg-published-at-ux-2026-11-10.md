# EPG header/footer publication clock (offline)

**Captured:** 2026-11-10. **Scope:** fixture tests in `tests/epg-published-at.mjs` and `tests/status-footer.mjs`. No production read or write.

Scan start `2026-11-10T16:00:00.000Z` (17:00 Europe/Madrid) and run completion `2026-11-10T17:36:16.213Z` (18:36 Europe/Madrid) stay distinct. After a complete run, `GET /api/programme` `publishedAt`, footer `integrations.sources[id=epg].lastSuccessAt` and the `epg` event `at` equal the completion clock. `programme.updatedAt` remains the scan clock. An in-flight `seal`/`epg` run and a failed unpublished run keep `lastEpgPublishedAt` from the previous completion. Invalid or missing clocks omit `publishedAt` / set `lastSuccessAt` null. Display uses `Europe/Madrid` even when `TZ` is `America/New_York`. D1 `published_epg_generation.published_at` is unchanged (still the scan clock at pointer switch) and is not the UX field.

**Verdict:** GO for the read-model overlay. Not production evidence of the 10 November Workflow run.
