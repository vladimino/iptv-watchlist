# Cloudflare recovery

- [Deployment metadata HTTP 403](deploy-metadata-403.md): diagnose dashboard-origin metadata permission failures.
- [Worker code rollback](cloudflare-worker-rollback.md): owner-approved code rollback and subsequent Git-first correction.
- [D1 authority and recovery](d1-authority-and-time-travel.md): which store is authoritative per domain, Film/Person held and forward-fix, D1 Time Travel as owner-approved recovery, and what R2 can and cannot restore.
- [Prediction expired-lease settlement](prediction-lease-settlement.md): status and runs project an expired lease; `prediction_start` persists it.

Do not treat a code rollback as R2, D1, authority-marker, secret, Access or Scheduled Task rollback. For ordinary deployment use [the main runbook](../deployment.md).
