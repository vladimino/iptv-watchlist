# Cloudflare recovery

- [Deployment metadata HTTP 403](deploy-metadata-403.md): diagnose dashboard-origin metadata permission failures.
- [Worker code rollback](cloudflare-worker-rollback.md): owner-approved code rollback and subsequent Git-first correction.
- [Prediction expired-lease settlement](prediction-lease-settlement.md): status and runs project an expired lease; `prediction_start` persists it.

Do not treat a code rollback as R2, secret, Access or Scheduled Task rollback. For ordinary deployment use [the main runbook](../deployment.md).
