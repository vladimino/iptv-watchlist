# EPG diagnostic canary foundation, offline evidence (AIR-453, 12 November 2026)

Scope: [ADR 0121](../../adr/0121-epg-diagnostic-rehearsal-design.md), offline code only. No Cloudflare resource, binding, migration, Workflow, route, flag or production read or write. All numbers come from `tests/epg-diagnostic-context.mjs` on sqlite stand-ins of D1 and in-memory buckets, run on 12 November 2026; the file runs in about 5 s.

| Claim | Result |
|---|---|
| Parity of the real seal path | The real `stageSealedGeneration` (planner, segment writes, manifest, pointer CAS, fences) on the diagnostic context and on a plain environment, five bounded generations: identical ledger and archive keys and payloads, identical R2 put counts and D1 row counts every generation; the plan archives departures |
| Counters | Reads and writes counted per resource; zero denied accesses and zero refused writes on a verified context |
| Lease renewal | A step lease with 100 s left is renewed to about a full 300 s by the fences of the real seal, same holder, pointer moved |
| Lease expiry and loss | Expired: `epg_step_fenced` with detail `lease_expired`, classified `step_lease_expired`, no manifest, pointer unchanged. Lost: detail `lease_lost`, classified `epoch_mismatch` |
| CAS and generation fences | A competing pointer write makes the swap fail and the other writer's pointer stays; a held published generation stops the archive before the pointer |
| Isolation | Without a verified identity every R2 and D1 write is refused before it reaches storage (the seal stops at its first write); a database and bucket with an identity that disagree, or a malformed one, are refused; a production-like database or bucket (data, or no identity table) is never provisioned; the production-like database and bucket of the same process are byte for byte unchanged by a whole diagnostic run |
| Allowlist | 24 production binding and secret names throw `diagnostic_binding_denied`; any other key cannot be set; a spread of the context carries only the allowlist. A first run found one implicit read, `env.epgPin` in the ledger locator: a generation-pin carrier set by code, not a binding, so it is a listed carrier |
| Mutation checks | 13 mutants (each removes one guard, among them every gate, the contradiction checks, the denied list, both identity comparisons and both emptiness checks) are each caught by the isolation checks |

Limits: stand-ins model neither Cloudflare latency nor D1/R2 contention; this is mechanics evidence, not `production-measured` and not AIR-444 acceptance. The application-enforced boundary is not platform isolation (residual risk in the [reference](../../reference/orchestration-reliability.md)).
