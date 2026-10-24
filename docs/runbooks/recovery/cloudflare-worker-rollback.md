# Cloudflare Worker rollback and recovery

**Approval gate:** rolling back or changing a live Worker version requires explicit owner authorization. This document does not authorize restoring production R2 data, modifying secrets, changing feature flags or Scheduled Tasks. See [deployment](../deployment.md).

## Code rollback boundary

Identify the previous known-good version in Cloudflare Deployments and roll back the Worker if needed. Verify Access, bindings, live version and read-only APIs.

Code rollback does not restore R2 data, secrets, environment configuration, or Scheduled Tasks. It also does not change GitHub `main`; a later push may supersede the rollback. Do not roll data back by replaying the 19 October 2026 snapshot over production R2. Backup of production data is a separate authorized read of bucket `iptv`, not a write from the legacy reserve.

For a permanent fix, merge a revert or corrective commit into `main` and deploy it through GitHub Actions. After deployment, use authorized read-only checks. Do not call sync, enrichment, prediction, schedule, or mutation endpoints as smoke tests. Do not enable Scheduled Tasks to prove a deploy.
