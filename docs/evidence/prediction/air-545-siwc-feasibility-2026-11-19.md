# AIR-545: Sign in with ChatGPT for a Cloudflare-managed Predictions v3 — read-only feasibility

[AIR-545](https://trello.com/c/dBh2iQye) · 19 November 2026 (UTC) · context: [AIR-461](https://trello.com/c/a9TdXgNM).

**Method.** Official OpenAI documentation pages only, fetched on 19 November 2026 (Markdown twins of the pages). No OAuth client was created, no consent was given, no token, model or API call was made, nothing in Cloudflare or production was touched, no form was submitted, no Scheduled Task was created. This is a documentation reading, not a measurement. Page revisions are not dated by the vendor; the statements below are as read on the fetch date and the "preview" pages can change.

## Verdict

| # | Mandatory check | Verdict | One-line basis |
| --- | --- | --- | --- |
| 1 | Remote hosting approved for a personal Cloudflare Worker/Workflow | **UNKNOWN** | Official scope is "open-source and locally hosted apps"; a remotely hosted app needs OpenAI's interest-form approval. No official page says a personal Worker is allowed or forbidden. |
| 2 | Model plus full-text web research | **UNKNOWN** | Responses API with `store:false`, `stream:true` and function tools is supported; web search is "subject to model and account/workspace policy"; whether the account's catalog offers a suitable model and whether full-text reading reaches S5 depth cannot be known without an authenticated call, which this card forbids. |
| 3 | Taste Profile parity path | **UNKNOWN** (path exists, parity unproven) | The call is stateless, so the versioned profile and instructions must be sent explicitly; this matches the repository's immutable profile versions. Parity with S5 is a measurement that has not been made. |
| 4 | No incremental cash cost, limits known | **UNKNOWN** | Plan usage is "included in the user's ChatGPT plan or available credits", and the user can choose whether an app may use credits after the plan limit. Numeric Pro limits and per-request cost are not published on the pages read. Cloudflare Worker/Workflow limits and cost could not be read from official Cloudflare documentation in this session (see Limitations). |

No mandatory condition is a documented **NO**, so no PoC is rejected on the evidence, but **no PoC is authorized either**: check 1 is a hard gate that only an owner action can open. Overall: **UNKNOWN, blocked on an owner-controlled approval**. This is not a finding that v3 is feasible, and it does not support "no feasible zero-cost v3" either; it supports "not yet decidable".

## 1. Official eligibility of a remotely hosted Worker

Sources: [ChatGPT plan usage overview](https://developers.openai.com/siwc/token-sharing-open-source), [Quickstart](https://developers.openai.com/siwc/quickstart), [Request a client ID](https://developers.openai.com/siwc/request-client-id), [Self-hosted VMs](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms), [Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions).

- Overview: "These docs explain ChatGPT plan usage for open-source and locally hosted apps. If you're interested in offering it in a paid or remotely hosted app, complete the interest form." The form is `https://openai.com/form/sign-in-with-chatgpt-interest/`.
- Quickstart: "ChatGPT plan usage is available to all open-source partners and selected private clients." Request a client ID: Sign in with ChatGPT "is currently offered to a select group of commercial partners".
- Three deployment shapes, kept apart:

| Shape | Documented position |
| --- | --- |
| OSS / local app | The documented flow. Dynamic client registration (`client_id=dynamic_agent_client`), no client secret, no partner key, loopback redirect `http://127.0.0.1:<port>/auth/callback`, "Do not substitute with `localhost`". |
| Self-hosted VM | Documented: sign in locally, then copy the protected credential file (`client_id`, `access_token`, `refresh_token`, `id_token`) over a secure channel such as SSH; the VM keeps its own `ext_agent_host_id` and owns later refreshes. Caveat in the page: "Host-specific usage attribution and revocation of ChatGPT plan access for transferred sessions are not yet available." |
| Remotely hosted application | Not covered by the documented flow; requires the interest form and OpenAI approval. |

- A Cloudflare Worker is not a VM and has no loopback callback, so the OSS flow cannot run on it. The only mechanical route would be an out-of-band local sign-in and a credential transfer into Worker-side storage. The VM page describes that only for a self-hosted VM and an open-source tool's "documented VM path"; it says nothing about serverless platforms. The credential-security page asks for "protected local or self-hosted runtime storage", which Cloudflare secrets/D1 neither clearly meet nor clearly violate.
- Using that transfer to avoid the interest form would be exactly the "bypass instead of approval" the card rules out, so this brief does not treat it as a path.

**Owner action (not taken):** the owner decides whether to submit the interest form for a personal, single-user, remotely hosted app, and in what words. It is an outward-facing statement on the owner's behalf; it needs its own explicit owner GO, and nothing in AIR-545 or AIR-461 grants it. Until OpenAI answers, check 1 stays UNKNOWN. If OpenAI declines remote hosting, the verdict becomes NO and v3 on Cloudflare via SIWC ends without a PoC.

Other eligibility facts that bear on the owner's own account: the Quickstart says "Eligible ChatGPT Plus and Pro users can use their ChatGPT plan"; errors list `subscription_sharing_user_not_eligible` (403) "unavailable for the selected user, workspace, or policy". Which plan the owner holds is not known to this brief and was not read.

## 2. Model, tools, limits

Sources: [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference), [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations), [Token reference](https://developers.openai.com/siwc/token-sharing-open-source/token-reference), [Errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery).

- Endpoint: `POST https://api.openai.com/v1/responses` with `Authorization: Bearer <access token>`; "do not point it at ChatGPT's `backend-api` endpoints". Model list: `GET https://api.openai.com/v1/models` with the same token; the catalog is per ChatGPT account, so the available models are known only after sign-in.
- Required: `store:false`, `stream:true`; success only after `response.completed`; usage errors can arrive mid-stream as `response.failed` (`subscription_sharing_usage_limit_exceeded`, `subscription_sharing_usage_unavailable`).
- No history or memory: `previous_response_id` omitted over HTTP, the needed history goes in `input`; "does not grant access to their ChatGPT conversations or other account context".
- Unsupported request fields include `background`, `conversation`, `max_output_tokens`, `max_tool_calls`, `metadata`, `prompt`, `temperature`, `top_p`, `truncation`, `user`. Explicit `system` message items are rejected; use `instructions` or developer messages.
- Tools: function/custom tools supported (namespaced or via `additional_tools`); web search "remains subject to model and account/workspace policy". Unsupported: image generation, file search, Code Interpreter, native computer use, **hosted MCP/connectors, and Responses `tool_search`**. A v3 executor would therefore have to call the repository's batch tools as function tools it executes itself, not through a hosted MCP server.
- Inputs: text, images, files when the model accepts them; no audio/video, no Files upload API.
- Token lifecycle: access token 1 hour (`expires_in: 3600`); refresh token 30 days, replaced on every refresh (rotating), "serialize refreshes for the same session so two processes do not race a rotating token"; unusable-token codes (`invalid_grant`, `refresh_token_reused`, …) require repeating the interactive OAuth. `host_id` is an opaque `ext_agent_host_id` (`urn:ietf:params:oauth:jwk-thumbprint:…`, `urn:uuid:…` or `did:key`), chosen and persisted before the first sign-in; "A host ID is not an authentication credential" and OpenAI does not verify key possession.
- Disconnect: "OpenAI does not currently notify your tool when a user disconnects the app in ChatGPT settings"; the app finds out on a request or refresh failure.
- Rate and concurrency limits: **not published** on these pages. Only the usage model is described: ChatGPT Settings → Usage per app with a weekly app limit (10% to 100%) and a credits switch; for Plus a shared five-hour limit across apps, "The five-hour usage limit does not apply for Pro users". No requests-per-minute or concurrent-stream figure was found.

Consequence for the two model checks: whether web search with full-text review reading works for this account, and which model is offered, is **UNKNOWN** until an authenticated test. Such a test is only a proposal (below), not run.

**Proposal for a separate owner-GO test (not run, not authorized).** Only after check 1 is resolved: one local, owner-present sign-in with one explicit host ID, `GET /v1/models`, then a frozen S5 batch of five films through `POST /v1/responses` (`store:false`, `stream:true`, `instructions` = frozen contract, profile in `input`), tokens kept out of git, logs and Trello. Record the model slug, the granted scopes, the web-search tool behaviour, whether each film's reviews were read in full, stream completion, the usage figures shown in ChatGPT Settings → Usage, and every error code. The owner would set the app's weekly limit and keep "use credits after plan limit" off, so a limit stops the test instead of spending credits.

## 3. Taste Profile and the future parity gate

- Mechanism: the call carries no memory, so the profile must be an explicit input. The repository already holds an immutable versioned profile (`GET /api/enrichment/profile`, `version`, `profileHash`; [publication runbook](../../runbooks/taste-profile-publication.md)), published manually by the owner. A v3 request would send that exact body plus the frozen prediction contract and research-first instructions, and record `version` and `profileHash` with the result. Nothing is learned from chats automatically; profile evolution stays the owner's manual publication.
- The accepted baseline is S5 from [AIR-450](https://trello.com/c/VPd21Y9d) and [AIR-473](https://trello.com/c/b9oTfOpI): five-film research-first execution with full-text reviews (S5 25.43 s/film, 5/5 films with full-text reviews and six sources; S10 was faster but 0/5 full-text; limited sample, see [AIR-473 evidence](air-473-production-c-fulltext-2026-11-15.md) and [offline A/B](air-476-offline-ab-v2-2026-11-18.md)).
- **Parity is not claimed.** A future blind gate, to be fixed by the owner before any run, compares v3 with frozen S5 cases on the same films, profile version and contract, without the generator seeing hidden ratings:
  1. Full-text provenance: per film, count of sources actually read in full versus snippets, with source identity; snippets must not be counted as full text. Pass: no film at or below S5's worst observed full-text count.
  2. Structural validity per film (first-pass valid rate), not JSON validity as a quality proxy.
  3. Rating fidelity against the hidden ratings where available: MAE and bias of `predictedRating`, 4.0 threshold accuracy, and calibration of P(4+) (`probability4Plus`).
  4. Consistency: repeat the same film at least twice; difference in rating and in P(4+), agreement of the 4.0 threshold.
  5. Reasoning evidence: `matchSignals`, `mainRisk` and plot mechanics supported by cited sources; assessment provenance (model, date, profile hash).
  6. Throughput and cost: seconds per film, tokens and plan-usage share consumed, in plan terms, with $0 extra billing.
  Numeric thresholds are for the owner to set; this brief invents none.

## 4. Cloudflare Worker/Workflow suitability

- What the SIWC pages require of the runtime, independent of Cloudflare: a long-lived streamed HTTPS response read to `response.completed`; durable storage of a rotating refresh token with serialized refresh; an interactive local OAuth step that a Worker cannot perform (loopback callback); a stable per-host ID; bounded backoff on `503` and usage errors.
- Fit in principle: the repository's Workflows already provide durable steps, retries and single-flight leases ([scheduling and orchestration](../../architecture/scheduling-and-orchestration.md)), and D1 mutable prediction authority stays the writer.
- **Not verified:** Worker and Workflow limits (wall time, CPU, subrequest and streaming behaviour, step timeout/retry bounds) and the incremental cost of running such a Workflow. `developers.cloudflare.com` was not reachable from this session (proxy answered 403), so no official Cloudflare statement is cited here. Those facts are UNKNOWN for this brief, not assumed.
- OAuth security notes for a design, if check 1 ever opens: refresh token and access token only in Worker secrets or encrypted storage, never in logs, Trello, git or analytics; one writer for the refresh to avoid rotating-token races; no new Access bypass; the existing owner-only Access rules stay as documented ([authentication and MCP](../../architecture/authentication-and-mcp.md)).

## 5. SIWC, API credits and Agents API are different things

| | Sign in with ChatGPT plan usage | API credits for ChatGPT subscribers | Agents API |
| --- | --- | --- | --- |
| Source | [SIWC docs](https://developers.openai.com/siwc/token-sharing-open-source) | [API credits guide](https://developers.openai.com/api/docs/guides/chatgpt-api-credits) | [Agents API overview](https://developers.openai.com/api/docs/guides/agents-api/overview) |
| Credential | Per-user OAuth access token (1 h) plus rotating refresh token; no API key | Ordinary project API key of an API organization the owner owns | API key |
| Billing | Against the user's ChatGPT plan usage or available credits; no API payment method | Paid API usage billed to the linked organization, covered by free credits first | "Model usage is billed at the selected model's API rates"; sandboxes at container rates |
| Quota | Plan limits plus an app-level weekly limit; Plus five-hour shared limit | Pro $100/$200/$500 per month; Business $20 per Standard or $100 per Premium seat, pooled and capped at $500 per workspace per month; unused credits expire at the end of the cycle; at zero: HTTP `429` `credit_balance_exhausted` unless purchased credits exist | API rates |
| Eligibility | OSS/local apps; remote hosting by approval | Active paid Pro or Business subscription at least seven days old, owner of both the subscription and the API organization, same email | API organization |
| Chat personalization | None: "does not grant access to their ChatGPT conversations or other account context" | None; stateless API | None |
| Fit with the owner's "no paid LLM API" rule | Unproven (check 1) | **Owner decision**: it is real API usage that is free only within monthly credits and only on an eligible plan; "No API payment method required" avoids cash overrun, but credits are not guaranteed forever ("while these benefits are available") | Same as credits; usage is billed, not plan-included |

The card names a "Workspace Agents API". No page with that name was found in the OpenAI Developers documentation index in this session; only the Agents API overview above was read, so no claim is made about a separate Workspace Agents API.

The API-credits route is **not** evaluated as a v3 candidate here because the owner's constraints exclude paid LLM APIs and a plan-benefit route needs its own decision on whether credits count as zero cost. It is recorded so that decision can be made deliberately.

## Limitations

- Documentation only; no behaviour of the live service was observed. Preview pages may change; re-read before acting.
- `developers.cloudflare.com` unreachable (HTTP 403 from the session proxy): Cloudflare limits and cost not covered.
- Model catalog, web-search policy for the owner's account, numeric plan limits and approval timing are unknowable without the owner's action.
- No claim of parity with S5, of zero cost, or of permission to host remotely.

## Owner actions and gates (nothing performed)

1. Decide whether to submit the SIWC interest form for a personal remotely hosted app (needs an explicit owner GO; outward-facing).
2. Only after an approval answer: separate GO for the authenticated test above, with the owner present and limits set.
3. Separately decide whether API credits on an eligible Pro/Business plan are acceptable as "$0 extra".
4. Allow `developers.cloudflare.com` in the session network to close the Cloudflare half of check 4 (read-only).

Documentation impact: this report, the registry row in `docs/evidence/README.md`, and a handoff comment on AIR-461. No architecture, runtime or production change. Rollback: none, read-only.
