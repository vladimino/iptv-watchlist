---
name: cloudflare-observability-read
description: How a session reads the Worker `iptv` logs (for example the `d1_enrichment_projection` run summaries) through the Cloudflare API connector, because the deprecated Cloudflare Observability connector rejects every events/invocations response. Use whenever a check needs per-run log fields of the production Worker.
---

# Reading Worker logs from a session

## Which connector works

- **Use** `mcp__Cloudflare_API__execute` (load it with `ToolSearch` query `select:mcp__Cloudflare_API__search,mcp__Cloudflare_API__execute`). It calls the telemetry query endpoint and returns the response unchanged.
- **Do not use** `mcp__Cloudflare_Observability__query_worker_observability` for `events` or `invocations`: it validates the answer against a schema that requires `$workers.requestId`, the events of this Worker do not carry it, and every call fails with `invalid_union ... requestId`. Its `calculations` view and `observability_keys` / `observability_values` do work, but the run summary is one JSON log line, not extracted keys, so they cannot sum or filter its fields. The server is also marked deprecated by Cloudflare.

## Authorization

The call is `POST /accounts/{id}/workers/observability/telemetry/query`, a POST that only runs a read query: it changes no Worker, data, flag, Task or cron. It is a verified safe observation (L0). Never use the same connector for any other write.

## Call shape that works

Timeframe is Unix **milliseconds**. Filter the service with a `filters` entry and the text with `needle`; a `$metadata.message includes` filter finds nothing, because the run summary is the structured log body, not the message.

```js
async () => {
  const from = Date.parse('2026-11-10T06:00:00Z'), to = Date.parse('2026-11-10T12:00:00Z');
  const r = await cloudflare.request({
    method: 'POST',
    path: `/accounts/${accountId}/workers/observability/telemetry/query`,
    body: {
      queryId: 'projector-runs', view: 'events', limit: 60, dry: true,
      timeframe: { from, to },
      parameters: {
        filters: [{ key: '$metadata.service', operation: 'eq', type: 'string', value: 'iptv' }],
        needle: { value: 'd1_enrichment_projection', matchCase: false }
      }
    }
  });
  return (r.result?.events?.events || []).map(e => {
    const s = e.source || {};           // the run summary object
    return { started: s.startedAt, outcome: s.outcome, remaining: s.remaining,
             films: s.writtenFilms, people: s.writtenPeople, errors: (s.errors || []).length,
             retained: (s.retainedFilms || []).length, window: s.window, bulk: s.bulk };
  }).sort((a, b) => String(a.started).localeCompare(String(b.started)));
}
```

- Pass `truncate: true`; return only the fields needed. Never return full events: `retainedFilms` and `errors` hold film ids.
- `view: 'events'` reads `r.result.events.events`; each item has `source` (the parsed log body), `timestamp`, `$metadata`.
- Fields of the run summary used by the AIR-383 acceptance: `outcome` (`complete`, `partial`, `budget`), `remaining`, `writtenFilms`, `writtenPeople`, `errors[]`, `retainedFilms[]` (reason `duplicate_film_retained`), `window.{outcome,waitMs,heldMs}`, `bulkBudget`, `bulk.{stop,groups,films,people,fallbacks,guardRefusals}`.
- A run can be missing from the logs although D1 shows its writes (seen for the 09:00 UTC run of 2026-11-10); say "not in the logs", do not guess the cause.

## Limits

- Logs are kept for a limited time (the tool states a maximum range of 7 days); older runs come from the dated evidence files.
- The run table in D1 (`projection_run`) holds only the latest summary; per-run history is read from these logs.

## Never

- Print tokens, secrets, personal data, or film/person ids into chat, Trello, GitHub or evidence beyond what the card needs.
- Use this connector to change anything in Cloudflare.
