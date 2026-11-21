# ADR 0189: The H0 proof of the EPG checkpoint cutover checks that nothing can write and that the deployed Worker is compatible, not that its version equals the finished instance's

**Status:** Accepted  
**Original decision date:** 2026-11-21  
**Recorded at:** 2026-11-21  
**Approval source:** [owner approval, variant B, in the AIR-551 card comment of 21 Nov 2026 17:13 UTC](https://trello.com/c/YAVPlcAe#comment-6b01d1517639f54f12a6fb8d)  
**Related work:** [AIR-551](https://trello.com/c/YAVPlcAe); [ADR 0185](0185-epg-checkpoint-d1-authority.md); [ADR 0176](0176-controlled-epg-workflow-rollover.md); the [EPG checkpoint runbook](../runbooks/epg-checkpoint-d1.md)  
**Supersedes:** Only one clause of decision 7(c) of ADR 0185: that the EPG Workflow instance must run the deployed version. ADR 0185 stays Accepted for everything else.  
**Superseded by:** None

## Context

Decision 7(c) of ADR 0185 requires, before the import, that the read-only preflight proves "the EPG Workflow instance runs the deployed version (the controlled rollover of ADR 0176 when it does not)". The operator implemented it as an equality between the `versionId` that the control record carries and the version of the current deployment.

That equality cannot hold on the day of the cutover. Every merge to `main` deploys a new Worker version (ten deployments on 21 Nov 2026 alone), and the `versionId` of the control record is a historical fact: the version that executed the last step of the finished instance. An instance that has finished is not made dangerous by a deploy after it. What the clause protects against is a Worker that does not know the checkpoint tables or the marker writing the frozen R2 objects after an activation, and an instance that is still alive on such code. Equality of identifiers is a proxy for that, and a proxy that forces the cutover to wait for the next natural run and to freeze all deliveries for a day.

## Decision

The H0 proof of `--hold` and `--hold-rollback` no longer compares the deployed version with the version of the finished instance. It requires instead, each fail-closed on missing, unknown or contradictory evidence:

1. **The instance is terminal and is the one the control record names** (unchanged): the `finished` liveness of that instance id.
2. **Nothing that could write is running**: the complete inventory of the non-terminal instances of the EPG Workflow (every one of `queued`, `running`, `waiting`, `paused`, `waitingForPause`, `rollingBack`, every page) finds none, together with the existing rules on the step lease, the control phase, the Discovery pause, event debt and the orchestration mode (`cloudflare`).
3. **The current deployment is one version at 100%** (no gradual rollout) **built from a commit that contains the D1 routing** of the checkpoint. The commit is named by the operator from the CI/CD run that deployed the version, and the operator **proves the containment itself with git** (the routing commit is an ancestor of, or equal to, the deployed commit); a commit that is unknown locally is not compatible.
4. **The stored R2 checkpoint is importable**: the import's own validation is run without writing before the hold freezes anything.

The historical `versionId` of the control record stays immutable evidence. It must be known, and the compare-and-swap of the marker batch pins it together with the control and lease revisions, so a rewrite of that record after the proof aborts the batch; a deploy after the proof does not. The finished Workflow instance is not rolled over, restarted or modified. The facts are re-read immediately before the hold, in a short agreed window without a deploy, a rollback or a manual run from H0 to the end of the activation; a whole day of frozen deliveries is not required.

Not decided: any operation. This record changes a criterion; the hold, import, activation and rollback keep their separate owner approvals. The schema-only `--apply` is unaffected (it never used the proof).

## Alternatives considered

- **Keep the equality.** Rejected by the owner: it defers the cutover to the next natural run and needs a freeze of deliveries for about a day.
- **Drop any version or compatibility check.** Rejected: an old Worker that writes the R2 objects after an activation is the risk the clause exists for.
- **Roll over or restart the finished instance onto the deployed version (ADR 0176).** Rejected: it modifies a finished run and its control record for the sake of an identifier.
- **Accept the operator's statement that the deployment is "compatible".** Rejected: compatibility must rest on evidence; the containment of the routing commit is checked with git, and the inventory and deployment facts are named flags that an independent reviewer repeats with the same Cloudflare reads.

## Consequences

- The cutover can run on the day the natural run completes, in a short window, whatever deploys followed that run.
- The operator carries more evidence flags (the commit, the deployment shape, the inventory). The Workflow and deployment reads are still made by the operator, because the operator's credentials cannot read them; what the tool verifies itself is the git containment, the pin of the control record and every D1 and R2 fact.
- Risk that remains: a Worker deployed after the proof and before the activation is not seen by the batch. The agreed window without a deploy covers it by procedure, and the facts are re-read right before the hold.

## Recovery and migration boundary

Nothing is applied or activated by this record. Code rollback reverts no data. The data rollback of ADR 0185 is unchanged, and `--hold-rollback` follows the same criterion.

## Evidence

- **Original decision:** the owner approval linked above.
- **Implementation:** the operator and its tests in the pull request that carries this record: the version-equality rule removed from `drainProof`, the new evidence, the git proof, the importability check and the pin of the control record's own version in `proofFacts`; the forward and rollback sequences run with different historical and deployed versions at schema 30, 31 and the latest.
- **Dated verification:** the read-only reference of 21 Nov 2026 (complete instance `epg_20261121_1`, no non-terminal instance in any of the six statuses, deployment at 100%) is the owner's and the coordinator's observation, to be repeated at the cutover; it is not an H0 result.
- **Uncertainty:** the Worker CPU and memory of the first natural run in `d1` mode and the real film figures are not established (see the dated evidence of AIR-551).

## Follow-ups

The H0 package and the bounded cutover proposal of [AIR-551](https://trello.com/c/YAVPlcAe). Current state belongs to Trello and GitHub.
