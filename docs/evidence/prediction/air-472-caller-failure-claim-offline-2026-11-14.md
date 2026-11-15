# AIR-472: caller failure claim, offline test evidence (14 Nov 2026)

Offline only: sqlite D1 stand-in and in-memory R2 on `main` plus the AIR-472 branch. No production call, run, Task or model execution.

| Check | File | Result |
| --- | --- | --- |
| Legacy `{failure:{kind}}` item answer and `inputDigest` unchanged (`24961787fcb62b0bd6dce25a84361a53741f2c75ffa4d4c89e35832f80845424` for `tmdb_1`, measured on the pre-change code) | `tests/prediction-caller-failure-claim.mjs` | pass |
| Claim stored as `validation.claimed` beside `issues:[]`, copied to the run failure and queue retry record; valid neighbour in the same batch is created; streak rule unchanged | same | pass |
| Identical claim replays, also with issues in another order; another reason, other issues, legacy against claim and claim against legacy are `conflict` | same | pass |
| Unknown reason, nested extra key, wrong type, foreign path, valid-looking unknown paths (`fingerprint.notARealField`, `fingerprint.evidence.group0.claim`, `fingerprint.evidence.execution.notADim`, `prediction.secretField`, `assessment.research.invented`), unknown code and 21 issues answer 400, nothing recorded, value not echoed; 20 issues accepted | same | pass |
| An invalid candidate carrying a claim is not accepted and nothing is written | same | pass |
| Diagnostics re-check the claim and show it only on a `caller_reported` record from `caller` | `tests/fingerprint-evidence.mjs` | pass |
| Every quoted fingerprint, prediction and assessment path literal of the validators, and every path a deliberately broken assessment makes `assessmentIssues` emit, is an allowed claim path (eight assessment paths added after review); invented paths are not | `tests/fingerprint-evidence.mjs` | pass |
| MCP tool schema publishes the issue shape (`path`, `code` enum, required, no extras) and stays free of the forbidden property names; batch submit handler validates the claim | `tests/mcp-tools.mjs` | pass |
| Canonical prompt sends reason and copied preflight issues as a claim, with a legacy fallback | `tests/scheduled-task-prompt-v2.mjs` | pass |

Limits: the crash-window comparison reuses the same digest helper but has no dedicated fixture for a failure item (a failure never commits a prediction, so that branch is not reachable for it). Prompt behaviour is not proven by a static test; a natural run under AIR-451 is required. The installed Task A prompt is unchanged and paused.
