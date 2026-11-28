// MCP endpoint (Streamable HTTP, JSON responses, stateless).
// Cloudflare Access application "IPTV MCP" (Managed OAuth) authenticates every
// request before it reaches the Worker. This module re-verifies the signed Access
// JWT. probe_read, probe_echo, feature_flags and prediction_batch_validate do not touch storage. The prediction diagnostic
// tools only read the existing queue and one requested film. The other EPG and
// prediction tools call the existing Worker functions; they do not accept a URL,
// an R2 key, or an API path.
// AIR-58 is the Access prerequisite, AIR-60 is the internal continuation used by the EPG step,
// and AIR-62 is the later decision to enable Scheduled Tasks. This module does not enable them.
const MCP_PROTOCOL_VERSIONS=['2025-11-25','2025-06-18'];
const MCP_SERVER_INFO={name:'iptv-watchlist-probe',title:'IPTV Watchlist MCP',version:'0.4.0'};
const MCP_INSTRUCTIONS='IPTV Watchlist MCP. Batch v2 tools a Scheduled Task must rediscover after initialize: prediction_batch_key (issues the invocation key of a deferred start), prediction_batch_start, prediction_batch_manifest, prediction_batch_validate, prediction_batch_hold, prediction_batch_submit, prediction_heartbeat, prediction_complete. probe_read and probe_echo only test the connection and do not touch stored data. feature_flags reads the registered feature flags of the deployed Worker and changes nothing. Read epg_status, epg_pipeline_status, enrichment_schema, enrichment_profile, enrichment_runner, enrichment_queue and enrichment_status before writing. epg_sync_start then epg_sync_step use the returned runId and advance one existing step at a time. After stage is complete, read discovery.nextAction: continue means call epg_sync_step again with the same runId; wait means do not call before discovery.nextCatchUpAt (a server gate, not a scheduled run; discovery.nextScheduledRunAt is unused and null — the Worker does not know the ChatGPT Task registry); stop means discovery is finished until the next EPG commit. ratingsPending does not request a Letterboxd retry. Personal ratings are written by the Letterboxd Sync Workflow and have no MCP writer: ratings_sync_status only reads that pipeline, and the EPG commit does not read Diary. Do not enable a ratings Scheduled Task. prediction_batch_start (batch runner v2) takes the runner lease and returns one manifest of up to 100 films with the profile, schema and metadata; already_running means stop and do not adopt that runId, manifest_too_large means nothing was created or shortened, and dryRun true writes nothing. A deferred start (deferred true with the key from prediction_batch_key, ADR 0193) answers a receipt, not a manifest: poll prediction_batch_manifest (manifest_pending means keep polling after retryAfterMs; start_refused and start_failed are final), heartbeat as soon as the envelope is ready, and send the same keyed start again for the same receipt. A formed prediction_batch_start JSON that does not parse is not a usable manifest: do not invent films; call prediction_batch_manifest for envelope, then profile, contract and each film, instead of a second start. prediction_batch_manifest only reads one stored part of the live lease holder and writes nothing; part=hold lists held filmIds and part=item returns one previously held submit-ready object. prediction_batch_validate stays read-only and stores nothing (ADR 0131). After a valid preflight, prediction_batch_hold persists the same items on the owned run so a later prediction_batch_submit({useHeld:true}) can commit them without regenerating. The legacy one-film runner v5 (prediction_start, prediction_next, prediction_submit, prediction_validate) is retired (ADR 0167). prediction_heartbeat renews the lease. prediction_complete only when the runner says mustComplete or a real quota, model, API or storage failure stops the run. Do not pass external_termination for a lost Task context: recover parts or held items, or complete with client_state_lost or manifest_unusable. Do not pass URLs, R2 keys or API paths. prediction_queue_overview, prediction_film_diagnostics and prediction_pending only read the existing queue and one requested film. They do not retry, reset or start a run. AIR-98. A formed prediction response is not proof the client received it. prediction_complete may include fault {origin, failedStep, providerErrorCode, httpStatus, receivedRequestId} only with an external or systemic stop reason; those values are caller-reported. Omit fault when the cause is unknown. A fault on a normal completion is rejected. receivedRequestId acknowledges only the matching step. AIR-88. Do not enable Scheduled Tasks; that is AIR-62. discovery_workflow_rollover is the owner-only controlled Discovery Workflow rollover onto the deployed version: dry_run writes nothing; apply requires confirmGo true, a requestId and the expect pins from a dry_run, and only with a separate owner GO. epg_workflow_rollover is the same kind of owner-only operator for the EPG Workflow (dry_run writes nothing; apply needs confirmGo, a requestId and the expect pins of a dry_run, and a separate owner GO). Prerequisites: AIR-58 authorization and AIR-60 one-chunk discovery.';
const MCP_ALLOWED_ORIGINS=['https://chatgpt.com'];
const MCP_MAX_BODY_BYTES=64*1024;
const MCP_MAX_JWT_LENGTH=8192;
const MCP_ECHO_MAX_CHARS=200;
const MCP_CLOCK_SKEW_SECONDS=60;
const MCP_JWKS_TTL_MS=60*60*1000;
const MCP_JWKS_RETRY_MS=30*1000;
const mcpJwksCache=new Map();
const MCP_READ={readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false};
const MCP_WRITE={readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false};
const MCP_WRITE_WORLD={readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true};
const MCP_RUN_ID={type:'string',minLength:1,maxLength:100,pattern:'^[A-Za-z0-9_-]{1,100}$',description:'runId returned by the matching start tool. Not an R2 key.'};
const MCP_TASK_ID={type:'string',enum:['task00','task15','task30','task45'],description:'The fixed, non-secret label of this Scheduled Task, written in its installed prompt (ADR 0195). It names the logical owner of a prediction run next to runId and epoch; it is not a credential and does not replace Cloudflare Access.'};
const mcpTaskId=value=>['task00','task15','task30','task45'].includes(value);
const MCP_CAPACITY={type:'object',properties:{remainingPercent:{type:'number',minimum:0,maximum:100}},additionalProperties:false,description:'Known remaining model capacity, 0–100. Omit when unknown.'};
const MCP_TOOLS=[
 {name:'probe_read',title:'Probe: read',description:'Use this to check that the IPTV Watchlist MCP connection and Cloudflare Access authorization work. Returns a fixed diagnostic report. It does not read watchlist, programme or any stored data. AIR-58.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:MCP_READ},
 {name:'probe_echo',title:'Probe: echo',description:'Use this to test a tool round trip. Returns the given short text unchanged. Nothing is stored. AIR-58.',inputSchema:{type:'object',properties:{text:{type:'string',minLength:1,maxLength:MCP_ECHO_MAX_CHARS,description:`Short test text, 1-${MCP_ECHO_MAX_CHARS} characters.`}},required:['text'],additionalProperties:false},annotations:MCP_READ},
 {name:'feature_flags',title:'Feature flags',description:'Read the registered Worker feature flags from the deployed environment in one call: for each flag whether it is set or absent, its literal value when it is made of known tokens (otherwise only its shape), whether the value is valid, the effective mode the code uses, and unmet requirements on other flags. Only the registered flags are read; no other binding, secret or token is returned. It does not read storage, change a flag or start anything. AIR-233.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:MCP_READ},
 {name:'epg_status',title:'EPG sync status',description:'Read the current EPG/watchlist sync stage, runId and remaining count. Same body as GET /api/status. It does not start sync. AIR-58; the following write steps depend on AIR-60, and AIR-62 enables the schedule.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:MCP_READ},
 {name:'epg_pipeline_status',title:'EPG pipeline status',description:'Read normalized EPG candidate, resolver and hot/cold queue counts. Same body as GET /api/enrichment/pipeline/status. It does not scan, resolve or write. view "operational" reads only the small Discovery records (authority, continuation, workflow, lease, last checkpoint) and stays readable while Discovery commits; the default "detailed" view reads the whole ledger under a snapshot fence and can answer discovery_fence during commits, which is not a failure of Discovery. AIR-58, AIR-60 and AIR-430.',inputSchema:{type:'object',properties:{view:{type:'string',enum:['operational','detailed'],description:'operational: bounded light status. detailed (default): full ledger statistics.'}},additionalProperties:false},annotations:MCP_READ},
 {name:'enrichment_schema',title:'Prediction schema',description:'Read the taste-profile and fingerprint schema the model must follow, including contract: the exact rules prediction_batch_submit validates with (required fields, enum values, list sizes, lengths) and the issue codes it reports. Check a fingerprint and prediction against contract before prediction_batch_submit. Same body as GET /api/enrichment/schema. Nothing is stored. AIR-58, AIR-152.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:MCP_READ},
 {name:'enrichment_profile',title:'Taste profile',description:'Read the published taste profile. Same body as GET /api/enrichment/profile. A missing profile means stop; this tool does not publish one. AIR-58.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:MCP_READ},
 {name:'enrichment_runner',title:'Prediction runner contract',description:'Read the current prediction runner contract before a run. Same body as GET /api/enrichment/runner. AIR-58. Enabling the hourly task is AIR-62.',inputSchema:{type:'object',properties:{taskId:MCP_TASK_ID},additionalProperties:false},annotations:MCP_READ},
 {name:'enrichment_queue',title:'Prediction queue',description:'Read prediction queue counts and the last batch. Same body as GET /api/enrichment/queue/status. It does not reconcile or start a run. AIR-58.',inputSchema:{type:'object',properties:{taskId:MCP_TASK_ID},additionalProperties:false},annotations:MCP_READ},
 {name:'enrichment_status',title:'Prediction status',description:'Read prediction runner state. Same body as GET /api/enrichment/status. An expired lease is projected as interrupted; the next prediction_batch_start persists it. It does not start a run or deliver events. AIR-58; schedule enablement is AIR-62.',inputSchema:{type:'object',properties:{taskId:MCP_TASK_ID},additionalProperties:false},annotations:MCP_READ},
 {name:'prediction_queue_overview',title:'Prediction queue overview',description:'Read the existing prediction queue: pending, eligible, deferred and retry-exhausted counts, the next retry time in UTC, coverage, and whether the queue, profile and published generation agree. A drained queue is distinct from one that is only waiting on retry. retryExhausted films are excluded from automatic selection and are not counted as predicted. This does not refresh, retry or start a run. AIR-98.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:MCP_READ},
 {name:'prediction_film_diagnostics',title:'Film prediction diagnostics',description:'Read one film already in storage: fingerprint and prediction presence, whether the prediction matches the current profile, queue lane, retry summary, and index agreement. Missing facts stay unknown or not_recorded. This does not create a fingerprint or a prediction. AIR-98.',inputSchema:{type:'object',properties:{filmId:{type:'string',minLength:1,maxLength:80,pattern:'^[A-Za-z0-9_-]{1,80}$',description:'Film id, 1–80 letters, digits, "_" or "-".'}},required:['filmId'],additionalProperties:false},annotations:MCP_READ},
 {name:'prediction_batch_validate',title:'Validate a group before batch submit',description:'Read-only preflight of 1 to 10 candidates of a batch runner v2 group, run after you have generated them and before prediction_batch_submit. Each item is {filmId, fingerprint?, prediction?, assessment?, metadata?}: the complete objects you intend to submit (a prediction_only film has only a prediction; pass metadata, the film modelMetadata, only when its fingerprint.evidence cites metadata tokens). It runs the same validators and the same ADR 0129 derivation as prediction_batch_submit, so a candidate that passes here is not refused for its fingerprint or prediction content at submit, and the issues are the same {path, code} of the closed vocabulary, per item, in request order, bound to the index and filmId you sent. A defect in one item never fails the others. It reads and writes no storage, run, lease, queue, profile, model, TMDB or EPG, does not check the frozen manifest, inputHash or live profile (prediction_batch_submit still does), and is not a submit. The optional assessment is checked exactly as the v2 submit checks it (closed keys, 3,000-byte serialized cap, source access, conflicts; issues use assessment.* paths, per item beside fingerprint and prediction); its verdict applies to prediction_batch_submit. The request is refused whole above 10 items, 56 KiB (57,344 bytes) or with a repeated filmId. Fix only what real knowledge or sources support; otherwise report that film as failure parse_error in prediction_batch_submit. contractVersion names the schema contract. AIR-450.',inputSchema:{type:'object',properties:{taskId:MCP_TASK_ID,items:{type:'array',minItems:1,maxItems:10,items:{type:'object',properties:{filmId:{type:'string',minLength:1,maxLength:80},fingerprint:{type:'object',description:'The complete fingerprint object you intend to submit.'},prediction:{type:'object',description:'The complete prediction object you intend to submit.'},assessment:{type:'object',description:'Optional v2 assessment you intend to submit beside the prediction.'},metadata:{type:'object',description:'Optional film modelMetadata, only when the fingerprint evidence cites metadata tokens.'}},required:['filmId'],additionalProperties:false}}},required:['items'],additionalProperties:false},annotations:MCP_READ},
 {name:'prediction_pending',title:'Prediction pending page',description:'Read one page of outstanding prediction film ids from the existing queue. filter is all, eligible, deferred or exhausted. exhausted lists films whose stored retry attempts reached 10; they are not eligible or deferred. limit is 1–20. Pass the returned cursor for the next page of the same snapshot. This does not list storage or start a run. AIR-98.',inputSchema:{type:'object',properties:{filter:{type:'string',enum:['all','eligible','deferred','exhausted']},limit:{type:'integer',minimum:1,maximum:20},cursor:{type:'string',minLength:1,maxLength:500,description:'Page token returned by the previous pending page.'}},required:['limit'],additionalProperties:false},annotations:MCP_READ},
 {name:'prediction_hot_parity',title:'Prediction hot queue parity',description:'Read-only comparison of the actual hot outstanding work with the persisted hot queue at one cutoff on one pinned published generation. The expected side is the queue builder run in memory on a fresh read, so the window, freshness, retry and eligibility rules are the queue\'s own. verdict is match, degraded (a clock-only window edge inside the 15-minute rate cap, or a queue still waiting for its own generation refresh), mismatch (with causes and at most 10 example film ids per side) or unknown (a source cannot be read, the generation, queue revision or assigned shows moved during the read, or the basis cannot be judged); unknown is never a match and a count of 0 is never claimed unread. This is a full read of the catalog, for an occasional owner check, not for every start. It does not refresh, settle, retry, start a run or call a model.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:MCP_READ},
 {name:'film_localization_diagnose',title:'Film localization cohort diagnosis',description:'Read-only census of the canonical D1 Film localization rows: for the range of Films it examined, how many are current (noop), stale (what the existing AIR-663 reconciler would repair), held (counts by reason), absent (redirect or missing) or unavailable (counts by error code). Each Film is classified by the existing resolver and planner (owner precedence and merged-ancestor owner entries included), never by an SQL guess. One call walks the Film table after the optional cursor Film by Film and returns aggregates only: counts, reasons, error codes, at most 200 Film ids per list, the Film/Person marker pin and the owner-review pin at the start and the end (pinsStable), the D1 queries it used and a cursor. It COUNTS its own D1 queries and stops before the next Film when the next one could pass the 1,000 queries per invocation that D1 allows on Paid (a batch counts once), or when its soft 20 s wall-time budget is spent: stopped is then d1_query_budget or budget, a normal continuation to resume at cursor; failure names a real failure. The gate requires the Film/Person marker open and the owner-review domain d1 with writes open or held, even for an empty table. complete is true only for a call that started at the first Film and reached the end of the table; a resumed call, or a clean range after the last stale Film, is never complete and never zeroEligible. To conclude zero eligible Films the caller must add contiguous ranges from the first Film to a reachedEnd range, every one rangeClean (no stale, no unavailable, no failure, stable pins) with identical pins. A census of observations at the time each Film was read, not a global snapshot. It writes nothing, opens no receipt, repairs nothing and calls no external service. AIR-683.',inputSchema:{type:'object',properties:{after:{type:'string',maxLength:200,description:'Continuation cursor (a Film id from a previous answer, starting with "film:"). Omit to start at the first Film.'}},additionalProperties:false},annotations:MCP_READ},
 {name:'prediction_batch_key',title:'Issue the invocation key of a deferred batch start',description:'Issue one fresh server-generated invocationKey (shape dk1.<32 hex>) for a deferred prediction_batch_start (ADR 0193). Call it once per execution, before the start, keep the key and send the SAME key on every repeat of that start; a repeat of this call only returns another unused key. It reads and writes nothing: no lease, no run, no storage, so a lost answer leaves nothing behind. The key is not composed from the model, the time, the Task name or the slot, and it is never reused across executions.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:MCP_READ},
 {name:'prediction_batch_manifest',title:'Read owned batch manifest part',description:'Read one bounded, self-contained JSON part of the stored prediction_batch_start answer for an already-owned batch_v2 run. part is envelope (default), profile, contract, film, hold or item. film and item require filmId. Each answer is one complete JSON object (no structuredContent). Assemble envelope+profile+contract+every film; a missing part is not a usable manifest. For a deferred start (ADR 0193) it also answers manifest_pending (HTTP 409 with retryAfterMs: keep polling) while the run is being prepared, and the final start_refused or start_failed (outcomeCode); the manifest is served only once the run is ready. part=hold lists filmIds previously stored by prediction_batch_hold; part=item returns that film\'s submit-ready object. Writes nothing, does not renew the lease, is not a second prediction_batch_start. Missing, expired, legacy v5 or spent runs are refused. Dry-run starts store nothing. AIR-510.',inputSchema:{type:'object',properties:{taskId:MCP_TASK_ID,runId:MCP_RUN_ID,part:{type:'string',enum:['envelope','profile','contract','film','hold','item']},filmId:{type:'string',minLength:1,maxLength:80,pattern:'^[A-Za-z0-9_-]{1,80}$'}},required:['taskId','runId'],additionalProperties:false},annotations:MCP_READ},
 {name:'epg_sync_start',title:'Start EPG sync',description:'Start one EPG/watchlist sync, or return the active run when it is still within its freshness window. No arguments: the Worker chooses the Letterboxd and EPG sources. Returns runId, stage and remaining. Then call epg_sync_step. AIR-58. The EPG commit pauses discovery for a later step. AIR-62 enables the schedule.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:MCP_WRITE_WORLD},
 {name:'epg_sync_step',title:'Advance EPG sync one step',description:'Advance the runId from epg_sync_start by one existing step: one metadata batch, the EPG commit, one bounded step of the staged ledger publication (stage `seal`: the response carries a `seal` object and `nextAction` continue until the run is complete), or one discovery chunk. The response discovery object has state, remainingChunks and nextAction. continue: call again now with the same runId. wait: do not call before nextCatchUpAt, a server gate; nextScheduledRunAt is unused and null. stop: do not call until the next EPG commit. ratingsPending is not a reason to retry Letterboxd. This tool accepts no URL, R2 key, limit or chunk count. AIR-58 and AIR-60; AIR-62 enables the schedule.',inputSchema:{type:'object',properties:{runId:MCP_RUN_ID},required:['runId'],additionalProperties:false},annotations:MCP_WRITE_WORLD},
 {name:'ratings_sync_status',title:'Letterboxd ratings status',description:'Read the permanent separate Letterboxd ratings pipeline in one call: switch is always separate (the retired RATINGS_PIPELINE binding is ignored; feature_flags reports it), the effective pipeline (blocked, idle, running, isolated), the storage schema guard as `storage` ({supported, authority: open|held|unavailable, queueV2, cursorV2}; the pipeline is blocked unless the Ratings D1 authority is open or absent and both stored objects are in the version 2 form), the run record with its lease and staleness, the Diary cursor and the removal queue counts. diary.enabled is the permanent Diary capability and does not prove a fetch or that the retired LETTERBOXD_DIARY_HISTORY binding is absent. removal.lookupEnabled is the permanent per-film lookup capability and does not prove a fetch or that the retired REMOVAL_RATING_LOOKUP binding is absent. Same body as GET /api/letterboxd/ratings/status. It writes nothing: it never closes a stale run, takes a lease or requests Letterboxd.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:MCP_READ},
 {name:'prediction_batch_start',title:'Start batch prediction run (v2)',description:'Start a batch runner v2 run: one call returns one manifest of at most manifestSize eligible films (integer 1..100, default 100 when omitted; server ceiling limits.maxManifestFilms stays 100) with the full taste profile, the schema and versions, and each film\'s modelMetadata, work plan and (for prediction_only) stored fingerprint, plus the owned runId and lease epoch. The answer echoes manifestSize (requested) and filmsSelected (actual). No enrichment_profile or metadata call is needed afterwards. trigger is scheduled or manual. Pass capacity.remainingPercent only when the real value is known. already_running is success: stop and do not adopt that runId. manifest_too_large means nothing was created and nothing was shortened: stop and report bytes, limit and largestFilmBytes. batch_runner_requires_d1 means v2 does not run on this storage mode. dryRun true reads and writes nothing (no lease, run, queue or storage write) and returns the same manifest with runId null and a manifestHash; pin {filmIds} (dryRun only) selects exactly those queued films and must not exceed the effective manifestSize. This does not generate a fingerprint or a prediction and starts no Scheduled Task. invocationKey (optional, 16 to 128 characters of letters, digits, . _ : -; ADR 0188) names one Task invocation and must be identical on every repeat of this start in that invocation. For a synchronous keyed start (ADR 0188) it is composed by the caller and unique per Task and slot; a deferred start (deferred true, ADR 0193) uses ONLY the key issued by prediction_batch_key, never a composed one: a repeat with the same key and the same arguments returns the same run\'s manifest, or status start_pending with runId, epoch and retryAfterMs, in which case read the manifest with prediction_batch_manifest (manifest_pending means not stored yet) or send the same start again; it never adopts another invocation\'s run. Without a key nothing changes. deferred true (ADR 0193) needs the invocationKey issued by prediction_batch_key and is never combined with dryRun or pin: the start answers within seconds with a receipt {status accepted, runId, epoch, phase preparing or ready, retryAfterMs} and prepares the manifest in the background; read it with prediction_batch_manifest (manifest_pending means keep polling after retryAfterMs, start_refused or start_failed are final) and repeat the same keyed start for the same receipt. answer envelope (AIR-588, ADR 0205; real synchronous starts only, never with dryRun or deferred) returns, instead of the whole manifest, its compact ready envelope (kind envelope, status running, runId, lease with epoch, manifestHash, limits and the part list) once the manifest is stored; read profile, contract and every film with prediction_batch_manifest, check each part against manifestHash, and submit under the same runId and epoch. A repeat of the same Task start with answer envelope returns the same envelope. answer full or no answer keeps the whole manifest.',inputSchema:{type:'object',properties:{taskId:MCP_TASK_ID,trigger:{type:'string',enum:['scheduled','manual']},capacity:MCP_CAPACITY,manifestSize:{type:'integer',minimum:1,maximum:100},dryRun:{type:'boolean'},invocationKey:{type:'string',minLength:16,maxLength:128,pattern:'^[A-Za-z0-9._:-]{16,128}$'},deferred:{type:'boolean'},answer:{type:'string',enum:['full','envelope']},pin:{type:'object',properties:{filmIds:{type:'array',items:{type:'string',minLength:1,maxLength:100},minItems:1,maxItems:100}},required:['filmIds'],additionalProperties:false}},required:['trigger'],additionalProperties:false},annotations:MCP_WRITE},
 {name:'prediction_batch_submit',title:'Submit a group of predictions (v2)',description:'Submit 1 to 10 films of a batch runner v2 run (see prediction_batch_start): each item is {filmId, fingerprint?, prediction, assessment?} or {filmId, failure:{kind, reason, preflight?:{issues:[{path,code}]}}} (each issue is exactly a path the Worker validators can report and an issue code, at most 20, checked by the Worker; reason is required, one of preflight_validation_failed, insufficient_evidence, json_unparseable, request_too_large; a missing reason is 400 and writes nothing; the echoed last preflight issues are an optional closed-vocabulary claim of why the caller reports the film, stored as a caller claim and never as Worker validation; the optional assessment is the v2-only, separately stored per-film diagnostic of docs/reference/api/prediction-assessment.md: 3,000-byte cap, never an input to a rule, written once per prediction version, answered per film as assessment written, present, not_sent or not_applicable), with the runId and the lease epoch the start and every answer return. The Worker validates every film once, here, against the schema contract (prediction_batch_validate is an optional read-only preflight). Each film has its own result: created, recalculated, already_current, needs_regeneration (the taste profile moved under the run and this film is reached by the change), validation_failure (a sanitized stage and issue codes, retryable by the existing policy, never resubmitted in the run), blocked, deferred_budget, not_in_manifest or conflict. A group is not atomic: after a lost answer, a timeout or a 502 submit the same body again, committed films come back replayed. submit_in_flight means an earlier call of this run is still running: wait retryAfterMs and replay the same body. A group over 56 KiB is refused with nothing submitted: split it. profile.changed true carries the new profile and the filmIds to regenerate, and action complete means call prediction_complete with reason profile_changed. dryRun true validates and writes nothing (optional manifestHash, contract and per-item inputHash from a dry-run manifest). A stored legacy v5 run is refused with wrong_protocol.',inputSchema:{type:'object',properties:{taskId:MCP_TASK_ID,runId:MCP_RUN_ID,epoch:{type:'integer',minimum:1},items:{type:'array',minItems:1,maxItems:10,items:{type:'object',properties:{filmId:{type:'string',minLength:1,maxLength:80},fingerprint:{type:'object'},prediction:{type:'object'},assessment:{type:'object'},failure:{type:'object',properties:{kind:{type:'string',enum:['parse_error','validation_error']},reason:{type:'string',enum:['preflight_validation_failed','insufficient_evidence','json_unparseable','request_too_large']},preflight:{type:'object',properties:{issues:{type:'array',maxItems:20,items:{type:'object',properties:{path:{type:'string',maxLength:120},code:{type:'string',enum:ISSUE_CODES}},required:['path','code'],additionalProperties:false}}},required:['issues'],additionalProperties:false}},required:['kind','reason'],additionalProperties:false},inputHash:{type:'string'}},required:['filmId'],additionalProperties:false}},dryRun:{type:'boolean'},manifestHash:{type:'string'},contract:{type:'object'},useHeld:{type:'boolean'}},required:['taskId','runId','epoch'],additionalProperties:false},annotations:MCP_WRITE},
 {name:'prediction_batch_hold',title:'Hold validated batch items',description:'Persist 1 to 10 already generated submit-ready items after prediction_batch_validate passed them. Write authorization is the live lease and epoch of the generating run; the stored objects are transferable (origin runId is provenance only). The next prediction_batch_start drains them into a new run without that lease. prediction_batch_validate still writes nothing (ADR 0131). Not a submit. AIR-510.',inputSchema:{type:'object',properties:{taskId:MCP_TASK_ID,runId:MCP_RUN_ID,epoch:{type:'integer',minimum:1},items:{type:'array',minItems:1,maxItems:10,items:{type:'object',properties:{filmId:{type:'string',minLength:1,maxLength:80},fingerprint:{type:'object'},prediction:{type:'object'},assessment:{type:'object'},failure:{type:'object'}},required:['filmId'],additionalProperties:false}}},required:['taskId','runId','epoch','items'],additionalProperties:false},annotations:MCP_WRITE},
 {name:'prediction_heartbeat',title:'Renew prediction lease',description:'Renew the 12-minute lease for an owned running prediction run. Call it before a long model generation and at least every 5 minutes during one. AIR-58.',inputSchema:{type:'object',properties:{taskId:MCP_TASK_ID,runId:MCP_RUN_ID},required:['taskId','runId'],additionalProperties:false},annotations:MCP_WRITE},
 {name:'prediction_complete',title:'Complete prediction run',description:'Finish the owned run. Omit reason when the queue is empty. For a batch_v2 run whose every selected manifest film is settled (created/recalculated/already_current or a recorded per-film retry) while ready films remain in the global queue, pass reason manifest_spent: that is a normal status:complete with a truthful Event, not time_budget and not «Прогнозы приостановлены». Unsubmitted or deferred_budget slots are refused. Otherwise pass a short reason such as quota, model_unavailable, api_error, storage_error or external_termination. HTTP 503 prediction_catalog_held is a wait: the run is not completed, no Event is written; retry complete later or leave the lease to expire, do not treat it as a systemic stop. Optional fault is caller-reported, only with that external or systemic reason, and does not prove a Worker failure. Omit it when the cause is unknown. A fault on a normal completion is rejected. Repeating a finished run does not create a second event. AIR-58. AIR-88. AIR-62 enables the schedule.',inputSchema:{type:'object',properties:{taskId:MCP_TASK_ID,runId:MCP_RUN_ID,reason:{type:'string',minLength:1,maxLength:80},fault:{type:'object',additionalProperties:false,properties:{origin:{type:'string',enum:['worker_http','transport','model_provider','orchestrator','unknown']},failedStep:{type:'string',enum:['start','next','submit','heartbeat','complete','validate','manifest','hold']},providerErrorCode:{type:'string',minLength:1,maxLength:40},httpStatus:{type:'integer',minimum:100,maximum:599},receivedRequestId:{type:'string',minLength:1,maxLength:80}}}},required:['taskId','runId'],additionalProperties:false},annotations:{...MCP_WRITE,idempotentHint:true}},
 {name:'discovery_workflow_rollover',title:'Discovery Workflow rollover',description:'Owner-only controlled rollover of the Discovery Workflow onto the deployed Worker version (AIR-524, ADR 0164). mode dry_run reads and writes nothing: it returns decision eligible, already_current, unsafe or unknown, the blockers, and the expect pins. apply requires confirmGo true, a requestId and the exact expectedProgrammeRunId, expectedInstanceId and expectedSeries from a dry_run; it swaps the executor record to the deterministic successor (series + 1) of the same generation by compare-and-swap only while the owner is asleep, creates it and reads it back. A repeat of the same requestId never swaps twice. Any mismatch or unsafe state refuses with zero writes. A merge or this tool listing is not a production GO; call apply only with a separate owner approval. No URL, R2 key or database id argument.',inputSchema:{type:'object',properties:{mode:{type:'string',enum:['dry_run','apply']},confirmGo:{type:'boolean'},requestId:{type:'string',minLength:8,maxLength:64,pattern:'^[A-Za-z0-9_-]{8,64}$'},expectedProgrammeRunId:{type:'string',minLength:1,maxLength:80},expectedInstanceId:{type:'string',minLength:1,maxLength:80,pattern:'^discovery_[0-9A-Za-z]{1,32}_[0-9]{1,6}$'},expectedSeries:{type:'integer',minimum:0}},required:['mode'],additionalProperties:false},annotations:MCP_WRITE},
 {name:'epg_workflow_rollover',title:'EPG Workflow rollover',description:'Owner-only controlled rollover of the running EPG Workflow onto the deployed Worker version (ADR 0176). mode dry_run reads and writes nothing: it returns decision eligible, already_current, unsafe or unknown, the blockers or unknowns, the deployed and the instance version and the expect pins. apply requires confirmGo true, a requestId and the exact expectedRunKey, expectedEpoch, expectedSeries, expectedInstanceId, expectedRunId and expectedControlRevision from a dry_run; it swaps the control record to the deterministic successor (series + 1) of the same run by one compare-and-set only while the owner is provably asleep outside a step, creates it and reads it back. It never resets a lease, budget, cooldown or quarantine, never publishes and never terminates an instance. A repeat of the same requestId never swaps twice. Any mismatch or unsafe state refuses with zero writes. A merge or this tool listing is not a production GO; call apply only with a separate owner approval. No URL, R2 key or database id argument.',inputSchema:{type:'object',properties:{mode:{type:'string',enum:['dry_run','apply']},confirmGo:{type:'boolean'},requestId:{type:'string',minLength:8,maxLength:64,pattern:'^[A-Za-z0-9_-]{8,64}$'},expectedRunKey:{type:'string',pattern:'^\\d{4}-\\d{2}-\\d{2}$'},expectedEpoch:{type:'integer',minimum:0},expectedSeries:{type:'integer',minimum:0},expectedInstanceId:{type:'string',minLength:1,maxLength:80,pattern:'^epg_\\d{8}_\\d{1,6}$'},expectedRunId:{type:['string','null'],maxLength:100},expectedControlRevision:{type:'integer',minimum:1}},required:['mode'],additionalProperties:false},annotations:MCP_WRITE},
 {name:'watchlist_membership_operator',title:'Watchlist membership operator',description:'Owner-only operator of the canonical Watchlist membership rollout (ADR 0203, AIR-572): the one-time baseline reconciliation of watchlist_film and the switch of its writer from the EPG Producer to the Letterboxd Sync. Dormant: nothing runs without a call. mode status (the default) and baseline_dry_run read and write nothing: status returns the membership marker, the current Watchlist version and drain, the Letterboxd Sync epoch, the Producer delivery hold and its non-terminal chains, and the expect pins; baseline_dry_run returns the counts of the baseline plan (add, remove, keep, unresolved), never an id. baseline_apply (confirmGo true, expectedVersion, expectedMarkerGeneration from status) applies at most 25 Film membership changes per call through the existing version-fenced Film writer under the Sync epoch fence, sends unresolved ids to the durable handoff ledger, and records the baseline proof only when nothing remains for that exact, fully drained version; repeat it until decision baseline_recorded. switch (confirmGo true, expectedVersion, expectedMarkerGeneration) requires the marker producer at that generation, the proof equal to the current drained version, the Producer delivery hold on and no non-terminal Producer chain, then switches the writer to sync (roll-forward only). No Film id, lid, SQL or URL argument; never creates a Film; never lifts the Producer hold.',inputSchema:{type:'object',properties:{mode:{type:'string',enum:['status','baseline_dry_run','baseline_apply','switch']},confirmGo:{type:'boolean'},expectedVersion:{type:'integer',minimum:1},expectedMarkerGeneration:{type:'integer',minimum:0}},additionalProperties:false},annotations:MCP_WRITE},
 {name:'letterboxd_claim_backfill',title:'Letterboxd claim backfill',description:'Owner-only bounded backfill of the trusted Letterboxd claims that published lids lack (AIR-559, ADR 0184). The server derives the cohort itself from the current published run and the authoritative Ratings link index (no lid, movie id, Film id, SQL, URL or list argument) and judges every pair with the real read-only planner. mode dry_run (also the default when mode is omitted; only an explicit mode apply can write) reads and writes nothing: it returns decision eligible, already_current, unsafe or unknown, the blocker reasons with counts, both authority generations, the publication pin (run id and both publication generations), the cohort count, the digest of the sorted lid:tmdb cohort and the expect pins; never a lid-to-movie mapping. apply requires confirmGo true, a requestId and the exact expectedFilmPersonGeneration, expectedRatingsGeneration, expectedProgrammeRunId, expectedPublicationGeneration, expectedWatchlistGeneration, expectedCount and expectedDigest from a dry_run; it derives the cohort again, refuses with zero writes on any mismatch, any non-eligible state, two candidates for one Film or a cohort over 12, checks the frozen markers once more immediately before the first write, and otherwise writes only through the existing fenced film_external_ids unit (revision CAS, write-time guards that also pin the approved generations and the publication, applied receipt), one pair after another, stopping at the first pair that is not proved, then reads back (catalogStartedFilm found, remaining cohort, row deltas). It never creates a Started mark, Event, alias, rating or Film. A merge or this tool listing is not a production GO; call apply only with a separate owner approval of the frozen cohort.',inputSchema:{type:'object',properties:{mode:{type:'string',enum:['dry_run','apply']},confirmGo:{type:'boolean'},requestId:{type:'string',minLength:8,maxLength:64,pattern:'^[A-Za-z0-9_-]{8,64}$'},expectedFilmPersonGeneration:{type:'integer',minimum:0},expectedRatingsGeneration:{type:'integer',minimum:0},expectedProgrammeRunId:{type:'string',minLength:1,maxLength:100,pattern:'^[A-Za-z0-9_.:-]{1,100}$'},expectedPublicationGeneration:{type:'integer',minimum:0},expectedWatchlistGeneration:{type:'integer',minimum:0},expectedCount:{type:'integer',minimum:1,maximum:12},expectedDigest:{type:'string',pattern:'^[0-9a-f]{64}$'}},additionalProperties:false},annotations:MCP_WRITE},
 {name:'producer_chain_operator',title:'Producer chain operator',description:'Owner-only terminalization of a stale canonical Producer chain (AIR-572). While the static Producer delivery hold is on, the hourly reconcile returns before it supersedes anything, so a chain of an older published EPG run can stay open and the Watchlist membership switch refuses producer_chain_open. mode status (the default) reads and writes nothing: it returns the Film/Person route, the published run and generation, the hold, and at most 10 open chains (pending, active, released, or stopped with a recoverable class), each with its owner state, revision, lease, whether it was ever claimed or linked a pass run, eligibility or the reason it is not eligible, and the expect pins. supersede (confirmGo true, expectedProgrammeRunId and expectedRevision from status) makes exactly the transition the hourly reconcile makes for a chain of a run that is no longer published: the existing supersedeChain (Film/Person marker fence, revision CAS, one row). Its batch also pins the published run and generation it read and that the run of the chain is not published, so a publication between the read and the write rolls it back (published_moved). It refuses with zero writes unless the hold is on, the chain is open, its run is not the published one and no owner lease is live. An outcome it cannot prove (a lost response or a failed readback after the batch) is never reported as zero writes: one read-only reconciliation of the chain either proves the transition (reconciled true) or answers HTTP 202 write_uncertain or readback_unproven with writes null, the observed row and the original pins; it never retries. It never creates a Workflow instance, changes no lease, epoch, run, receipt, Film, Person or Watchlist row and never lifts the hold. A merge or this listing is not a production GO.',inputSchema:{type:'object',properties:{mode:{type:'string',enum:['status','supersede']},confirmGo:{type:'boolean'},expectedProgrammeRunId:{type:'string',minLength:1,maxLength:160,pattern:'^[A-Za-z0-9_.:-]{1,160}$'},expectedRevision:{type:'integer',minimum:1}},additionalProperties:false},annotations:MCP_WRITE},
 {name:'film_localization_repair',title:'Film localization one-off repair',description:'Owner-only ONE-OFF repair of the 16 Film localization rows the AIR-683 census found stale (AIR-664, ADR 0225). The cohort is a fixed constant of the server: the caller supplies no Film id list (restore takes one id and refuses any that is not in the cohort), key, SQL or intent body. Every Film goes through the delivered AIR-663 exact-intent path: the intent is recorded in the existing private R2 bucket (isolated prefix, immutable objects, conditional create, full readback) BEFORE the D1 write, then ONE receipted atomic fenced batch, then the settled outcome. R2 holds recovery artifacts only and is never proof of a D1 effect; canonical D1 stays the authority. mode preflight (the default) and recover read and write nothing. preflight reads the server clock once (planAt), re-derives all 16 Films at that time and answers per-Film CURRENT state (eligible, recorded, in_flight, applied, applied_moved, applied_unproved, restored, restored_moved, restored_unproved, noop, held, absent, unavailable; a restored Film is a deliberate rollback, never a repair) with request id and digest, counts, the authority pins and the expect pins (Film/Person generation, schema version, owner-review generation and writes, planAt, count, digest). recover classifies each recorded intent against its receipt and revision, settles nothing, and for an applied intent returns the restore proof (state, eligible, digest) a restore is approved against. apply (confirmGo true and every expected* of a preflight: expectedFilmPersonGeneration, expectedSchemaVersion, expectedOwnerReviewGeneration, expectedOwnerReviewWrites, expectedPlanAt, expectedCount, expectedDigest) re-derives the cohort at exactly that plan time and writes only if it equals the pins, re-checks the pins before every Film and asserts them in the SAME batch as every receipt reservation and domain write; it stops on the first moved, unknown or failed Film, never retries blind, recovers a recorded intent before any new one, classifies an unnamed outcome from the receipt, revision and row, and answers counts, per-Film states, writes (a number only when proved and attributed to this call, otherwise null) and a current scoped readback of all 16 Films. Every call runs behind the counting meter with the real limit of 1,000 D1 queries per Worker invocation enforced and reports d1Queries and d1QueryLimit; apply stops BEFORE a Film that could pass the limit (stopped d1_query_budget), a normal continuation through a fresh preflight. A later legitimate change to an applied Film is reported (applied_moved), never overwritten and never complete. restore (confirmGo true, filmId, the four pin arguments and expectedRestoreDigest from recover) restores ONE Film only while it is still at exactly the recorded post-revision with the row equal to the post-image, asserts the pins at the restore receipt and in its batch, and is recovered by its own receipt (a replay or concurrent commit is alreadyApplied with writes 0, a lost reply is classified and never retried blind, an attempt that may still be in flight is restore_in_flight). Responses carry counts, ids, digests and pins, never a localization value, an intent body or an R2 key. No migration, table, queue, Workflow, Task, flag or deletion. A merge or this tool listing is not a production GO; call apply or restore only with a separate owner approval.',inputSchema:{type:'object',properties:{mode:{type:'string',enum:['preflight','recover','apply','restore']},confirmGo:{type:'boolean'},expectedFilmPersonGeneration:{type:'integer',minimum:0},expectedSchemaVersion:{type:'integer',minimum:1},expectedOwnerReviewGeneration:{type:'integer',minimum:0},expectedOwnerReviewWrites:{type:'string',enum:['open','held']},expectedPlanAt:{type:'string',pattern:'^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$'},expectedCount:{type:'integer',minimum:1,maximum:16},expectedDigest:{type:'string',pattern:'^[0-9a-f]{64}$'},filmId:{type:'string',minLength:6,maxLength:40,description:'restore only: one Film id of the fixed cohort.'},expectedRestoreDigest:{type:'string',pattern:'^[0-9a-f]{64}$',description:'restore only: the restore.digest recover returned for this Film.'}},additionalProperties:false},annotations:MCP_WRITE},
];
const mcpJson=(value,status=200,headers={})=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers}});
const mcpError=(id,code,message,status=200,headers)=>mcpJson({jsonrpc:'2.0',id,error:{code,message}},status,headers);
const mcpIsObject=value=>!!value&&typeof value==='object'&&!Array.isArray(value);

function mcpBase64UrlBytes(value){
 if(typeof value!=='string'||!/^[A-Za-z0-9_-]*$/.test(value))throw new Error('Invalid base64url');
 const binary=atob(value.replace(/-/g,'+').replace(/_/g,'/')+'==='.slice((value.length+3)%4));
 const bytes=new Uint8Array(binary.length);for(let index=0;index<binary.length;index++)bytes[index]=binary.charCodeAt(index);return bytes;
}
const mcpBase64UrlJson=value=>JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(mcpBase64UrlBytes(value)));
function mcpTeamDomain(value){
 if(typeof value!=='string')return null;
 const domain=value.trim().replace(/\/+$/,'');
 return /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(domain)?domain:null;
}
async function mcpFetchAccessKeys(teamDomain){
 const response=await fetch(teamDomain+'/cdn-cgi/access/certs',{headers:{Accept:'application/json'},redirect:'manual',signal:AbortSignal.timeout(5000)});
 if(!response.ok)throw new Error('Access certs HTTP '+response.status);
 const body=await response.json();if(!mcpIsObject(body)||!Array.isArray(body.keys))throw new Error('Invalid Access certs');
 const keys=new Map();
 for(const jwk of body.keys){
  if(!mcpIsObject(jwk)||jwk.kty!=='RSA'||typeof jwk.kid!=='string'||typeof jwk.n!=='string'||typeof jwk.e!=='string')continue;
  if((jwk.alg!==undefined&&jwk.alg!=='RS256')||(jwk.use!==undefined&&jwk.use!=='sig'))continue;
  try{keys.set(jwk.kid,await crypto.subtle.importKey('jwk',{kty:'RSA',n:jwk.n,e:jwk.e,alg:'RS256',ext:true},{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']));}catch{}
 }
 if(!keys.size)throw new Error('No usable Access signing keys');
 return {keys,fetchedAt:Date.now()};
}
async function mcpAccessKey(teamDomain,kid){
 const cached=mcpJwksCache.get(teamDomain),age=cached?Date.now()-cached.fetchedAt:Infinity;
 if(age<MCP_JWKS_TTL_MS&&cached.keys.has(kid))return cached.keys.get(kid);
 // An unknown kid triggers at most one refresh per retry window (key rotation).
 if(age<MCP_JWKS_RETRY_MS)return null;
 const fresh=await mcpFetchAccessKeys(teamDomain);mcpJwksCache.set(teamDomain,fresh);return fresh.keys.get(kid)||null;
}
// Trust only the signed Cf-Access-Jwt-Assertion header. Identity headers, the
// CF_Authorization cookie and the client's opaque OAuth bearer token are ignored.
// AIR-599: `audience` lets another owner-only route verify the same signed assertion against its own Access application (the `All Workers` AUD); the default is `IPTV MCP`.
async function mcpVerifyAccess(request,env,{audience:audienceOf=null}={}){
 const forbidden={ok:false,status:403,message:'Forbidden'};
 const audienceRaw=audienceOf===null?env.MCP_ACCESS_AUD:audienceOf;
 const teamDomain=mcpTeamDomain(env.MCP_ACCESS_TEAM_DOMAIN),audience=typeof audienceRaw==='string'?audienceRaw.trim():'';
 if(!teamDomain||!/^[A-Za-z0-9_-]{16,256}$/.test(audience))return {ok:false,status:503,message:'MCP authorization is not configured'};
 const token=request.headers.get('Cf-Access-Jwt-Assertion');
 if(!token||token.length>MCP_MAX_JWT_LENGTH)return forbidden;
 const parts=token.split('.');if(parts.length!==3)return forbidden;
 let header,signature;
 try{header=mcpBase64UrlJson(parts[0]);signature=mcpBase64UrlBytes(parts[2]);}catch{return forbidden;}
 if(!mcpIsObject(header)||header.alg!=='RS256'||typeof header.kid!=='string'||!header.kid||header.kid.length>256||!signature.length)return forbidden;
 let key;
 try{key=await mcpAccessKey(teamDomain,header.kid);}catch{return {ok:false,status:503,message:'Access signing keys are unavailable'};}
 if(!key)return forbidden;
 if(!await crypto.subtle.verify('RSASSA-PKCS1-v1_5',key,signature,new TextEncoder().encode(parts[0]+'.'+parts[1])))return forbidden;
 let claims;try{claims=mcpBase64UrlJson(parts[1]);}catch{return forbidden;}
 if(!mcpIsObject(claims)||claims.iss!==teamDomain)return forbidden;
 if(!(Array.isArray(claims.aud)?claims.aud:[claims.aud]).includes(audience))return forbidden;
 const now=Math.floor(Date.now()/1000);
 if(typeof claims.exp!=='number'||now-MCP_CLOCK_SKEW_SECONDS>=claims.exp)return forbidden;
 if(claims.nbf!==undefined&&(typeof claims.nbf!=='number'||claims.nbf>now+MCP_CLOCK_SKEW_SECONDS))return forbidden;
 if(claims.iat!==undefined&&(typeof claims.iat!=='number'||claims.iat>now+MCP_CLOCK_SKEW_SECONDS))return forbidden;
 // Managed OAuth forwards a user identity. Service-token assertions have an empty sub.
 if(typeof claims.sub!=='string'||!claims.sub)return forbidden;
 return {ok:true,subject:claims.sub,email:typeof claims.email==='string'?claims.email:null};
}

function mcpMediaType(value){return typeof value==='string'?value.split(';')[0].trim().toLowerCase():'';}
function mcpAcceptsJson(value){
 if(!value)return true;
 return value.split(',').map(mcpMediaType).some(type=>['application/json','application/*','*/*'].includes(type));
}
async function mcpReadBody(request){
 const declared=Number(request.headers.get('Content-Length'));
 if(Number.isFinite(declared)&&declared>MCP_MAX_BODY_BYTES)return null;
 if(!request.body)return new Uint8Array();
 const reader=request.body.getReader(),chunks=[];let size=0;
 for(;;){
  const {done,value}=await reader.read();if(done)break;
  size+=value.byteLength;if(size>MCP_MAX_BODY_BYTES){try{await reader.cancel();}catch{}return null;}
  chunks.push(value);
 }
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}return bytes;
}
const mcpToolError=message=>({content:[{type:'text',text:message}],isError:true});
const mcpRunId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(value);
function mcpCapacity(value){
 if(value===undefined)return true;
 if(!mcpIsObject(value))return false;
 if(Object.keys(value).some(key=>key!=='remainingPercent'))return false;
 if('remainingPercent' in value&&(typeof value.remainingPercent!=='number'||!Number.isFinite(value.remainingPercent)||value.remainingPercent<0||value.remainingPercent>100))return false;
 return true;
}
function mcpPayload(httpStatus,body){
 const payload=mcpIsObject(body)?{httpStatus,...body}:{httpStatus,result:body};
 const failed=httpStatus>=500||httpStatus===400||httpStatus===404||httpStatus===409||httpStatus===503;
 return {result:{content:[{type:'text',text:JSON.stringify(payload)}],structuredContent:payload,...(failed?{isError:true}:{})}};
}
async function mcpFromResponse(response){
 let body;try{body=await response.json();}catch{body={error:'Unreadable response'};}
 return mcpPayload(response.status,body);
}
async function mcpDomain(work){
 try{return await mcpFromResponse(await work());}catch(e){return {result:mcpToolError(String(e.message).slice(0,160))};}
}
function mcpEnrichment(env,execution,method,path,body){
 const url=new URL('https://iptv.internal'+path),init={method};
 if(body!==undefined){init.body=JSON.stringify(body);init.headers={'Content-Type':'application/json'};}
 return enrichmentRoute(new Request(url,init),env,url,execution);
}
function mcpRejectFields(name,args,allowed){
 if(Object.keys(args).some(key=>!allowed.includes(key)))return {result:mcpToolError(name+' accepts only'+(allowed.length?' '+allowed.join(', '):' no arguments')+'.')};
 return null;
}
function mcpSubmitItem(item){
 if(!mcpIsObject(item)||Object.keys(item).some(key=>!['filmId','fingerprint','prediction','failure'].includes(key)))return 'prediction_batch_submit item accepts only filmId, fingerprint, prediction, assessment, failure and inputHash.';
 if(typeof item.filmId!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(item.filmId))return '"filmId" must be 1–80 letters, digits, "_" or "-".';
 if(item.fingerprint!==undefined&&!mcpIsObject(item.fingerprint))return '"fingerprint" must be an object.';
 if(item.prediction!==undefined&&!mcpIsObject(item.prediction))return '"prediction" must be an object.';
 if(item.failure!==undefined&&(!mcpIsObject(item.failure)||Object.keys(item.failure).join()!=='kind'||!['parse_error','validation_error'].includes(item.failure.kind)))return '"failure.kind" must be parse_error or validation_error.';
 return null;
}
// One candidate, checked by the same validators prediction_batch_validate and prediction_batch_submit use (ADR 0129 derivation included). Pure: no storage, no run, no lease.
function mcpCandidateReport(fingerprintValue,predictionValue,metadata,assessmentValue){
 const fingerprint=fingerprintValue===undefined?{checked:false,issues:[]}:{checked:true,issues:fingerprintIssues(deriveFingerprintSource(fingerprintValue,metadata),metadata)};
 const prediction=predictionValue===undefined?{checked:false,issues:[]}:{checked:true,issues:predictionIssues(predictionValue)};
  const assessment=assessmentValue===undefined?{checked:false,issues:[]}:{checked:true,issues:assessmentIssues(assessmentValue,metadata)};
 return {fingerprint,prediction,assessment,valid:!fingerprint.issues.length&&!prediction.issues.length&&!assessment.issues.length};
}
// A defect of one item is its own result, in the closed vocabulary and without echoing any value. Only the item's own keys are accepted.
function mcpBatchCandidate(item,index){
 const out={index,filmId:null,valid:false,itemIssues:[],fingerprint:{checked:false,issues:[]},prediction:{checked:false,issues:[]},assessment:{checked:false,issues:[]}};
 if(!mcpIsObject(item)){out.itemIssues.push({path:'item',code:'invalid_type'});return out;}
 if(typeof item.filmId==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(item.filmId))out.filmId=item.filmId;else out.itemIssues.push({path:'item.filmId',code:item.filmId===undefined?'required':'invalid_type'});
 for(const key of Object.keys(item))if(!['filmId','fingerprint','prediction','assessment','metadata'].includes(key))out.itemIssues.push({path:'item.'+key.replace(/[^A-Za-z0-9_]/g,'_').slice(0,40),code:'unknown_field'});
 for(const key of ['fingerprint','prediction','assessment','metadata'])if(item[key]!==undefined&&!mcpIsObject(item[key]))out.itemIssues.push({path:'item.'+key,code:'invalid_type'});
 if(item.fingerprint===undefined&&item.prediction===undefined)out.itemIssues.push({path:'item',code:'required'});
 if(out.itemIssues.length)return out;
 const report=mcpCandidateReport(item.fingerprint,item.prediction,item.metadata,item.assessment);
 return {...out,valid:report.valid,fingerprint:report.fingerprint,prediction:report.prediction,assessment:report.assessment};
}
async function mcpCallTool(params,protocolVersion,env,execution){
 const args=params.arguments===undefined?{}:params.arguments;
 if(!mcpIsObject(args))return {error:'Invalid params: arguments must be an object'};
 if(params.name==='probe_read'){
  if(Object.keys(args).length)return {result:mcpToolError('probe_read takes no arguments.')};
  const report={status:'ok',server:MCP_SERVER_INFO.name,version:MCP_SERVER_INFO.version,transport:'streamable-http',protocolVersion,authorization:'cloudflare-access-jwt-verified',storage:'not_accessed',sideEffects:'none',time:new Date().toISOString()};
  return {result:{content:[{type:'text',text:JSON.stringify(report)}],structuredContent:report}};
 }
 if(params.name==='probe_echo'){
  if(Object.keys(args).some(key=>key!=='text'))return {result:mcpToolError('probe_echo accepts only the "text" argument.')};
  if(typeof args.text!=='string')return {result:mcpToolError('"text" must be a string.')};
  const length=[...args.text].length;
  if(length<1||length>MCP_ECHO_MAX_CHARS)return {result:mcpToolError(`"text" must contain 1-${MCP_ECHO_MAX_CHARS} characters.`)};
  return {result:{content:[{type:'text',text:args.text}],structuredContent:{echo:args.text,length}}};
 }
 if(!MCP_TOOLS.some(tool=>tool.name===params.name))return {error:'Unknown tool'};
 if(params.name==='prediction_batch_key'){
  // ADR 0193: stateless. No bucket, no lease, no write; the key is 128 random bits from the platform, formatted dk1.<32 hex>.
  if(Object.keys(args).length)return {result:mcpToolError('prediction_batch_key takes no arguments.')};
  const bytes=crypto.getRandomValues(new Uint8Array(16)),invocationKey='dk1.'+[...bytes].map(b=>b.toString(16).padStart(2,'0')).join('');
  const report={status:'issued',invocationKey,usage:'Send this exact key as prediction_batch_start.invocationKey with deferred true, and again on every repeat of that start in this execution.',sideEffects:'none'};
  return {result:{content:[{type:'text',text:JSON.stringify(report)}],structuredContent:report}};
 }
 if(params.name==='feature_flags'){
  // AIR-233: the allowlisted env bindings only, read by name; no storage, so it answers without a bucket binding.
  const rejected=mcpRejectFields(params.name,args,[]);if(rejected)return rejected;
  const report=featureFlagReport(env);
  return {result:{content:[{type:'text',text:JSON.stringify(report)}],structuredContent:report}};
 }
 if(params.name==='prediction_batch_validate'){
  // AIR-450 batch preflight: the same pure validators as prediction_batch_submit for 1 to 10 candidates, handled before the storage check, no storage, run, lease, queue or profile.
  const rejected=mcpRejectFields(params.name,args,['taskId','items']);if(rejected)return rejected;
  // ADR 0195: the label is a parameter of the Task workflow; the validation is read-only and never confirms ownership.
  if(args.taskId!==undefined&&!mcpTaskId(args.taskId))return {result:mcpToolError('"taskId" must be one of task00, task15, task30, task45: the fixed label in this Task\'s installed prompt.')};
  if(!Array.isArray(args.items)||args.items.length<1||args.items.length>10)return {result:mcpToolError('prediction_batch_validate accepts 1 to 10 items.')};
  const bytes=new TextEncoder().encode(JSON.stringify(args)).length;
  if(bytes>BATCH_RUNNER.submitMaxBodyBytes)return {result:mcpToolError('This request is '+bytes+' bytes, over the '+BATCH_RUNNER.submitMaxBodyBytes+' byte limit of one preflight (the MCP request limit is 65536). Nothing was checked: split the group and preflight it in smaller requests.')};
  const ids=args.items.filter(item=>mcpIsObject(item)&&typeof item.filmId==='string').map(item=>item.filmId);
  if(new Set(ids).size!==ids.length)return {result:mcpToolError('Each filmId may appear once in a request.')};
  const results=args.items.map(mcpBatchCandidate),valid=results.filter(result=>result.valid).length;
  const report={success:valid===results.length,valid:valid===results.length,contractVersion:schemaContract().version,results,counts:{items:results.length,valid,invalid:results.length-valid},storage:'not_accessed',sideEffects:'none'};
  return {result:{content:[{type:'text',text:JSON.stringify(report)}],structuredContent:report}};
 }
 if(params.name==='discovery_workflow_rollover'){
  const rejected=mcpRejectFields(params.name,args,['mode','confirmGo','requestId','expectedProgrammeRunId','expectedInstanceId','expectedSeries']);if(rejected)return rejected;
  if(typeof handleDiscoveryRolloverTool!=='function')return {result:mcpToolError('Discovery Workflow rollover operator is unavailable.')};
  try{const replied=await handleDiscoveryRolloverTool(env,args);return mcpPayload(replied.status,replied.body);}
  catch{return {result:mcpToolError('Discovery Workflow rollover unavailable')};}
 }
 if(params.name==='epg_workflow_rollover'){
  const rejected=mcpRejectFields(params.name,args,['mode','confirmGo','requestId','expectedRunKey','expectedEpoch','expectedSeries','expectedInstanceId','expectedRunId','expectedControlRevision']);if(rejected)return rejected;
  if(typeof handleEpgRolloverTool!=='function')return {result:mcpToolError('EPG Workflow rollover operator is unavailable.')};
  try{const replied=await handleEpgRolloverTool(env,args);return mcpPayload(replied.status,replied.body);}
  catch{return {result:mcpToolError('EPG Workflow rollover unavailable')};}
 }
 if(params.name==='watchlist_membership_operator'){
  const rejected=mcpRejectFields(params.name,args,['mode','confirmGo','expectedVersion','expectedMarkerGeneration']);if(rejected)return rejected;
  if(typeof handleWatchlistMembershipOperatorTool!=='function')return {result:mcpToolError('Watchlist membership operator is unavailable.')};
  try{const replied=await handleWatchlistMembershipOperatorTool(env,args);return mcpPayload(replied.status,replied.body);}
  catch{return {result:mcpToolError('Watchlist membership operator unavailable')};}
 }
 if(params.name==='producer_chain_operator'){
  const rejected=mcpRejectFields(params.name,args,['mode','confirmGo','expectedProgrammeRunId','expectedRevision']);if(rejected)return rejected;
  if(typeof handleProducerChainOperatorTool!=='function')return {result:mcpToolError('Producer chain operator is unavailable.')};
  try{const replied=await handleProducerChainOperatorTool(env,args);return mcpPayload(replied.status,replied.body);}
  catch{return {result:mcpToolError('Producer chain operator unavailable')};}
 }
 if(params.name==='letterboxd_claim_backfill'){
  const rejected=mcpRejectFields(params.name,args,['mode','confirmGo','requestId','expectedFilmPersonGeneration','expectedRatingsGeneration','expectedProgrammeRunId','expectedPublicationGeneration','expectedWatchlistGeneration','expectedCount','expectedDigest']);if(rejected)return rejected;
  if(typeof LetterboxdClaimBackfill==='undefined')return {result:mcpToolError('Letterboxd claim backfill operator is unavailable.')};
  try{const replied=await LetterboxdClaimBackfill.handleLetterboxdClaimBackfillTool(env,args);return mcpPayload(replied.status,replied.body);}
  catch{return {result:mcpToolError('Letterboxd claim backfill unavailable')};}
 }
 if(params.name==='film_localization_repair'){
  const rejected=mcpRejectFields(params.name,args,['mode','confirmGo','expectedFilmPersonGeneration','expectedSchemaVersion','expectedOwnerReviewGeneration','expectedOwnerReviewWrites','expectedPlanAt','expectedCount','expectedDigest','filmId','expectedRestoreDigest']);if(rejected)return rejected;
  if(typeof FilmLocalizationRepair==='undefined')return {result:mcpToolError('Film localization repair is unavailable.')};
  try{const replied=await FilmLocalizationRepair.handleFilmLocalizationRepairTool(env,args);return mcpPayload(replied.status,replied.body);}
  catch{return {result:mcpToolError('Film localization repair unavailable')};}
 }
 if(params.name==='film_localization_diagnose'){
  const rejected=mcpRejectFields(params.name,args,['after']);if(rejected)return rejected;
  if(args.after!==undefined&&(typeof args.after!=='string'||args.after.length>200||!args.after.startsWith('film:')))return {result:mcpToolError('"after" must be a Film id starting with "film:" (at most 200 characters).')};
  if(typeof FilmLocalizationReconciler==='undefined')return {result:mcpToolError('Film localization diagnosis is unavailable.')};
  try{return mcpPayload(200,await FilmLocalizationReconciler.diagnoseLocalizationCohort(env,{after:args.after}));}
  catch(error){return {result:mcpToolError('Film localization diagnosis unavailable'+(error?.code?' ('+error.code+')':''))};}
 }
 if(!env.BUCKET)return {result:mcpToolError('Storage unavailable')};
 const fields={epg_status:[],epg_pipeline_status:['view'],enrichment_schema:[],enrichment_profile:[],enrichment_runner:['taskId'],enrichment_queue:['taskId'],enrichment_status:['taskId'],prediction_queue_overview:[],prediction_film_diagnostics:['filmId'],prediction_pending:['filter','limit','cursor'],prediction_hot_parity:[],prediction_batch_manifest:['taskId','runId','part','filmId'],epg_sync_start:[],epg_sync_step:['runId'],prediction_batch_start:['taskId','trigger','capacity','manifestSize','dryRun','invocationKey','deferred','pin','answer'],prediction_batch_submit:['taskId','runId','epoch','items','dryRun','manifestHash','contract','useHeld'],prediction_batch_hold:['taskId','runId','epoch','items'],prediction_heartbeat:['taskId','runId'],prediction_complete:['taskId','runId','reason','fault'],ratings_sync_status:[]};
 const rejected=mcpRejectFields(params.name,args,fields[params.name]);if(rejected)return rejected;
 if(args.taskId!==undefined&&!mcpTaskId(args.taskId))return {result:mcpToolError('"taskId" must be one of task00, task15, task30, task45: the fixed label in this Task\'s installed prompt.')};
 if(params.name==='prediction_batch_manifest'){
  if(args.taskId===undefined)return {result:mcpToolError('"taskId" is required: send the fixed label of this Task (task00, task15, task30 or task45) on every call of a prediction run.')};
  if(!mcpRunId(args.runId))return {result:mcpToolError('"runId" must be 1–100 letters, digits, "_" or "-".')};
  if(args.part!==undefined&&!['envelope','profile','contract','film','hold','item'].includes(args.part))return {result:mcpToolError('"part" must be envelope, profile, contract, film, hold or item.')};
  if(args.filmId!==undefined&&(typeof args.filmId!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(args.filmId)))return {result:mcpToolError('"filmId" must be 1–80 letters, digits, "_" or "-".')};
  try{
   const replied=await ownedBatchManifest(env,args.runId,{part:args.part||'envelope',filmId:args.filmId,taskId:args.taskId});
   // ADR 0193 (AIR-573): a manifest that is not ready yet is a normal wait, not a failure. Only this one answer (HTTP 409 with code `manifest_pending` from the underlying read, which is unchanged) is
   // reported to the caller as a successful tool result: no `isError`, no `error`, an explicit `kind: 'pending'` that cannot be mistaken for an envelope, and the original `retryAfterMs`. Every other
   // refusal (start_refused, start_failed, lease_lost, unknown_run, invalid arguments, storage errors) keeps its error shape, and `mcpPayload` still treats every other 409 as an error.
   if(replied.status===409&&replied.body?.code==='manifest_pending'){
    const waiting={httpStatus:200,kind:'pending',status:'manifest_pending',code:'manifest_pending',retryAfterMs:Number.isFinite(replied.body.retryAfterMs)&&replied.body.retryAfterMs>0?replied.body.retryAfterMs:5000};
    return {result:{content:[{type:'text',text:JSON.stringify(waiting)}]}};
   }
   const answered=mcpPayload(replied.status,replied.body);
   if(answered.result&&!answered.result.isError){const {structuredContent,...result}=answered.result;return {result};}
   return answered;
  }catch{return {result:mcpToolError('Prediction manifest unavailable')};}
 }
 if(params.name==='prediction_queue_overview'||params.name==='prediction_film_diagnostics'||params.name==='prediction_pending'||params.name==='prediction_hot_parity'){
  try{
   const now=Date.now();
   if(params.name==='prediction_hot_parity')return mcpPayload(200,await predictionHotParity(env,now));
   if(params.name==='prediction_film_diagnostics'){
    if(typeof args.filmId!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(args.filmId))return {result:mcpToolError('"filmId" must be 1–80 letters, digits, "_" or "-".')};
    return mcpPayload(200,predictionFilmDiagnostic(await loadPredictionDiagnosticSnapshot(env,args.filmId),args.filmId,now));
   }
   if(params.name==='prediction_pending'){
    const query=predictionPendingQuery(args);
    if(query.error)return {result:mcpToolError(query.error)};
    const page=predictionPendingPage(await loadPredictionQueueSnapshot(env),args,now);
    if(page.error)return {result:mcpToolError(page.error)};
    return mcpPayload(200,page);
   }
   return mcpPayload(200,predictionQueueOverview(await loadPredictionDiagnosticSnapshot(env),now));
  }catch{return {result:mcpToolError('Prediction diagnostics unavailable')};}
 }
 if(params.name==='epg_status')return mcpPayload(200,await syncStatus(env));
 if(params.name==='epg_pipeline_status'){
  if(args.view!==undefined&&!['operational','detailed'].includes(args.view))return {result:mcpToolError('"view" must be "operational" or "detailed".')};
  return mcpDomain(()=>mcpEnrichment(env,execution,'GET','/api/enrichment/pipeline/status'+(args.view?'?view='+args.view:'')));
 }
 if(params.name==='enrichment_schema')return mcpDomain(()=>mcpEnrichment(env,execution,'GET','/api/enrichment/schema'));
 if(params.name==='enrichment_profile')return mcpDomain(()=>mcpEnrichment(env,execution,'GET','/api/enrichment/profile'));
 if(params.name==='enrichment_runner')return mcpDomain(()=>mcpEnrichment(env,execution,'GET','/api/enrichment/runner'));
 if(params.name==='enrichment_queue')return mcpDomain(()=>mcpEnrichment(env,execution,'GET','/api/enrichment/queue/status'));
 if(params.name==='enrichment_status')return mcpDomain(()=>mcpEnrichment(env,execution,'GET','/api/enrichment/status'));
 if(params.name==='epg_sync_start')return mcpDomain(()=>postSync(env,execution,'/api/sync/start',{}));
 if(params.name==='epg_sync_step'){
  if(!mcpRunId(args.runId))return {result:mcpToolError('"runId" must be 1–100 letters, digits, "_" or "-".')};
  const run=await loadJSON(env,'sync.json');
  return mcpDomain(()=>postSync(env,execution,!run||run.stage==='metadata'?'/api/sync/metadata':'/api/sync/epg',{runId:args.runId},'mcp'));
 }
 if(params.name==='ratings_sync_status')return mcpPayload(200,await LetterboxdRatings.status(env));
 if(params.name==='prediction_batch_start'){
  if(args.trigger!=='scheduled'&&args.trigger!=='manual')return {result:mcpToolError('"trigger" must be scheduled or manual.')};
  if(!mcpCapacity(args.capacity))return {result:mcpToolError('"capacity" accepts only remainingPercent from 0 to 100.')};
  if(args.manifestSize!==undefined&&(!Number.isInteger(args.manifestSize)||args.manifestSize<1||args.manifestSize>100))return {result:mcpToolError('"manifestSize" must be an integer from 1 to 100.')};
  if(args.dryRun!==undefined&&typeof args.dryRun!=='boolean')return {result:mcpToolError('"dryRun" must be true or false.')};
  if(args.deferred!==undefined&&typeof args.deferred!=='boolean')return {result:mcpToolError('"deferred" must be true or false.')};
  if(args.deferred===true&&(args.dryRun===true||args.pin!==undefined))return {result:mcpToolError('"deferred" is not accepted with dryRun or pin.')};
  if(args.deferred===true&&(typeof args.invocationKey!=='string'||!/^dk1\.[0-9a-f]{32}$/.test(args.invocationKey)))return {result:mcpToolError('A deferred start needs the "invocationKey" issued by prediction_batch_key.')};
  if(args.invocationKey!==undefined&&(typeof args.invocationKey!=='string'||!/^[A-Za-z0-9._:-]{16,128}$/.test(args.invocationKey)))return {result:mcpToolError('"invocationKey" must be 16 to 128 characters of letters, digits, ".", "_", ":" or "-".')};
  // ADR 0195: a real scheduled start of the standing Tasks carries the Task label; without it (and without the dormant keyed protocol) the call fails closed before any storage access.
  if(args.taskId!==undefined&&args.trigger!=='scheduled')return {result:mcpToolError('"taskId" is accepted only with trigger scheduled.')};
  if(args.trigger==='scheduled'&&args.dryRun!==true&&args.invocationKey===undefined&&args.taskId===undefined)return {result:mcpToolError('"taskId" is required: send the fixed label of this Task (task00, task15, task30 or task45) on every call of a prediction run.')};
  const manifestCap=args.manifestSize===undefined?100:args.manifestSize;
  if(args.pin!==undefined){
   if(args.dryRun!==true)return {result:mcpToolError('"pin" is accepted only with dryRun true.')};
   if(!mcpIsObject(args.pin)||Object.keys(args.pin).some(key=>key!=='filmIds')||!Array.isArray(args.pin.filmIds)||!args.pin.filmIds.length||args.pin.filmIds.length>manifestCap||args.pin.filmIds.some(id=>typeof id!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(id)))return {result:mcpToolError('"pin" must be {filmIds}: 1 to '+manifestCap+' film ids (the effective manifestSize).')};
  }
  const body={scope:'watchlist_all',mode:'queued',trigger:args.trigger};if(args.taskId!==undefined&&args.dryRun!==true)body.taskId=args.taskId;if(args.capacity)body.capacity=args.capacity;if(args.manifestSize!==undefined)body.manifestSize=args.manifestSize;if(args.dryRun===true)body.dryRun=true;if(args.invocationKey!==undefined)body.invocationKey=args.invocationKey;if(args.deferred===true)body.deferred=true;if(args.pin)body.pin={filmIds:args.pin.filmIds};if(args.answer!==undefined)body.answer=args.answer;
  const answered=await mcpDomain(()=>mcpEnrichment(env,execution,'POST','/api/enrichment/batch/start',body));
  // One copy in the tool result. structuredContent repeated the same JSON and the Scheduled Task working context dropped the manifest (AIR-510).
  if(answered.result&&!answered.result.isError){const {structuredContent,...result}=answered.result;return {result};}
  return answered;
 }
 if(params.name==='prediction_batch_hold'){
  if(!mcpRunId(args.runId))return {result:mcpToolError('"runId" must be 1–100 letters, digits, "_" or "-".')};
  if(args.taskId===undefined)return {result:mcpToolError('"taskId" is required: send the fixed label of this Task (task00, task15, task30 or task45) on every call of a prediction run.')};
  if(!Number.isInteger(args.epoch)||args.epoch<1)return {result:mcpToolError('"epoch" must be a positive integer: the lease epoch the start and every answer return.')};
  if(!Array.isArray(args.items)||args.items.length<1||args.items.length>10)return {result:mcpToolError('prediction_batch_hold accepts 1 to 10 items.')};
  const bytes=new TextEncoder().encode(JSON.stringify(args)).length;
  if(bytes>BATCH_RUNNER.submitMaxBodyBytes)return {result:mcpToolError('This group is '+bytes+' bytes, over the '+BATCH_RUNNER.submitMaxBodyBytes+' byte limit of one hold.')};
  return mcpDomain(()=>mcpEnrichment(env,execution,'POST','/api/enrichment/batch/hold',{taskId:args.taskId,runId:args.runId,epoch:args.epoch,items:args.items}));
 }
 if(params.name==='prediction_batch_submit'){
  if(!mcpRunId(args.runId))return {result:mcpToolError('"runId" must be 1–100 letters, digits, "_" or "-".')};
  if(!Number.isInteger(args.epoch)||args.epoch<1)return {result:mcpToolError('"epoch" must be a positive integer: the lease epoch the start and every answer return.')};
  // A real submit is the Task's own write; a dry run is a read-only check (ADR 0195) and needs no label.
  if(args.dryRun!==true&&args.taskId===undefined)return {result:mcpToolError('"taskId" is required: send the fixed label of this Task (task00, task15, task30 or task45) on every call of a prediction run.')};
  if(args.useHeld===true){
   if(args.items!==undefined)return {result:mcpToolError('"useHeld" cannot be combined with items.')};
   if(args.dryRun===true)return {result:mcpToolError('"useHeld" is not accepted with dryRun.')};
   return mcpDomain(()=>mcpEnrichment(env,execution,'POST','/api/enrichment/batch/submit',{taskId:args.taskId,runId:args.runId,epoch:args.epoch,useHeld:true}));
  }
  if(!Array.isArray(args.items)||args.items.length<1||args.items.length>10)return {result:mcpToolError('prediction_batch_submit accepts 1 to 10 items.')};
  if(args.dryRun!==undefined&&typeof args.dryRun!=='boolean')return {result:mcpToolError('"dryRun" must be true or false.')};
  if(args.dryRun!==true&&(args.manifestHash!==undefined||args.contract!==undefined))return {result:mcpToolError('"manifestHash" and "contract" are accepted only with dryRun true.')};
  if(args.manifestHash!==undefined&&!/^[0-9a-f]{64}$/.test(String(args.manifestHash)))return {result:mcpToolError('"manifestHash" must be 64 hexadecimal characters.')};
  if(args.contract!==undefined&&(!mcpIsObject(args.contract)||Object.keys(args.contract).some(key=>!['fingerprintSchemaVersion','fingerprintPromptVersion','predictionPromptVersion','registryDigest'].includes(key))))return {result:mcpToolError('"contract" accepts only fingerprintSchemaVersion, fingerprintPromptVersion, predictionPromptVersion and registryDigest.')};
  for(const item of args.items){
   const hash=mcpIsObject(item)?item.inputHash:undefined;
   if(hash!==undefined&&(args.dryRun!==true||!/^[0-9a-f]{24}$/.test(String(hash))))return {result:mcpToolError('"inputHash" is accepted only with dryRun true and is 24 hexadecimal characters.')};
   const {inputHash,assessment,...rest}=mcpIsObject(item)?item:{};
   if(assessment!==undefined&&!mcpIsObject(assessment))return {result:mcpToolError('"assessment" must be an object.')};
   if(mcpIsObject(item)&&item.failure!==undefined){const claimIssues=callerFailureIssues(item.failure);if(claimIssues.length)return {result:mcpToolError('prediction_batch_submit item "failure" is invalid: '+claimIssues.slice(0,5).map(x=>x.path+' '+x.code).join(', ')+'.')};}
   if(mcpIsObject(item)&&mcpIsObject(item.failure)){const {reason,preflight,...legacy}=item.failure;rest.failure=legacy;}
   const issue=mcpSubmitItem(mcpIsObject(item)?rest:item);if(issue)return {result:mcpToolError(issue)};
  }
  if(new Set(args.items.map(item=>item.filmId)).size!==args.items.length)return {result:mcpToolError('Each filmId may appear once in a group.')};
  const bytes=new TextEncoder().encode(JSON.stringify(args)).length;
  if(bytes>BATCH_RUNNER.submitMaxBodyBytes)return {result:mcpToolError('This group is '+bytes+' bytes, over the '+BATCH_RUNNER.submitMaxBodyBytes+' byte limit of one call (the MCP request limit is 65536). Nothing was submitted: split the group into smaller groups of films and submit them separately.')};
  const body={runId:args.runId,epoch:args.epoch,items:args.items};if(args.taskId!==undefined)body.taskId=args.taskId;if(args.dryRun===true)body.dryRun=true;if(args.manifestHash!==undefined)body.manifestHash=args.manifestHash;if(args.contract!==undefined)body.contract=args.contract;
  return mcpDomain(()=>mcpEnrichment(env,execution,'POST','/api/enrichment/batch/submit',body));
 }
 if(params.name==='prediction_heartbeat'||params.name==='prediction_complete'){
  if(args.taskId===undefined)return {result:mcpToolError('"taskId" is required: send the fixed label of this Task (task00, task15, task30 or task45) on every call of a prediction run.')};
  if(!mcpRunId(args.runId))return {result:mcpToolError('"runId" must be 1–100 letters, digits, "_" or "-".')};
 }
 if(params.name==='prediction_heartbeat')return mcpDomain(()=>mcpEnrichment(env,execution,'POST','/api/enrichment/heartbeat',{taskId:args.taskId,runId:args.runId}));
 if(params.name==='prediction_complete'){
  if(args.reason!==undefined&&(typeof args.reason!=='string'||[...args.reason].length<1||[...args.reason].length>80||/[\u0000-\u001f]/.test(args.reason)))return {result:mcpToolError('"reason" must be 1–80 characters without control characters.')};
  if(args.fault!==undefined&&!mcpIsObject(args.fault))return {result:mcpToolError('"fault" must be an object.')};
  if(args.fault!==undefined&&Object.keys(args.fault).some(key=>!['origin','failedStep','providerErrorCode','httpStatus','receivedRequestId'].includes(key)))return {result:mcpToolError('"fault" accepts only origin, failedStep, providerErrorCode, httpStatus and receivedRequestId.')};
  const body={taskId:args.taskId,runId:args.runId};if(args.reason!==undefined)body.reason=args.reason;if(args.fault!==undefined)body.fault=args.fault;
  return mcpDomain(()=>mcpEnrichment(env,execution,'POST','/api/enrichment/complete',body));
 }
 return {error:'Unknown tool'};
}
// AIR-579. One structured log line per authorized `tools/call`, so a later read of the Worker logs can attribute D1 and R2 load to MCP tools (the request log names only `POST /mcp`).
// The line carries the tool NAME, the outcome and the elapsed time, and nothing else: never an argument, a result, an identity or a header. A name that is not a registered tool is logged as
// `unregistered`, never as the caller's string. It runs after Access verification (an unauthenticated call logs nothing), it never throws into the call and it changes no response.
function mcpLogToolCall(name,outcome,started){
 try{
  const registered=MCP_TOOLS.some(tool=>tool.name===name);
  const kind=outcome===null?'failed':outcome.error?'rejected':outcome.result?.isError===true?'tool_error':'ok';
  console.log(JSON.stringify({event:'mcp_tool_call',tool:registered?name:'unregistered',outcome:kind,ms:Math.max(0,Date.now()-started)}));
 }catch{/* a log line is never part of the call */}
}
async function mcpDispatch(message,protocolVersion,env,execution){
 const {id,method}=message,params=message.params===undefined?{}:message.params;
 const ok=result=>({jsonrpc:'2.0',id,result}),fail=(code,text)=>({jsonrpc:'2.0',id,error:{code,message:text}});
 if(!mcpIsObject(params))return fail(-32602,'Invalid params');
 if(method==='initialize'){
  if(typeof params.protocolVersion!=='string')return fail(-32602,'Invalid params: protocolVersion is required');
  const negotiated=MCP_PROTOCOL_VERSIONS.includes(params.protocolVersion)?params.protocolVersion:MCP_PROTOCOL_VERSIONS[0];
  return ok({protocolVersion:negotiated,capabilities:{tools:{listChanged:true}},serverInfo:MCP_SERVER_INFO,instructions:MCP_INSTRUCTIONS});
 }
 if(method==='ping')return ok({});
 if(method==='tools/list')return ok({tools:MCP_TOOLS});
 if(method==='tools/call'){
  if(typeof params.name!=='string'||!params.name)return fail(-32602,'Invalid params: tool name is required');
  const started=Date.now();
  let outcome;
  try{outcome=await mcpCallTool(params,protocolVersion,env,execution);}
  catch(error){mcpLogToolCall(params.name,null,started);throw error;}
  mcpLogToolCall(params.name,outcome,started);
  return outcome.error?fail(-32602,outcome.error):ok(outcome.result);
 }
 return fail(-32601,'Method not found');
}
async function mcpRoute(request,env,execution){
 try{
  // Authorization runs first so that unauthenticated callers learn nothing else.
  const access=await mcpVerifyAccess(request,env);
  if(!access.ok)return mcpError(null,access.status===403?-32001:-32603,access.message,access.status);
  if(request.method!=='POST')return mcpError(null,-32000,'Method not allowed',405,{Allow:'POST'});
  const origin=request.headers.get('Origin');
  if(origin&&origin!==new URL(request.url).origin&&!MCP_ALLOWED_ORIGINS.includes(origin))return mcpError(null,-32000,'Origin not allowed',403);
  if(mcpMediaType(request.headers.get('Content-Type'))!=='application/json')return mcpError(null,-32000,'Content-Type must be application/json',415);
  if(!mcpAcceptsJson(request.headers.get('Accept')))return mcpError(null,-32000,'Accept must allow application/json',406);
  const bytes=await mcpReadBody(request);
  if(bytes===null)return mcpError(null,-32000,'Request body too large',413);
  let message;
  try{message=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{return mcpError(null,-32700,'Parse error',400);}
  if(Array.isArray(message))return mcpError(null,-32600,'Batch requests are not supported',400);
  if(!mcpIsObject(message)||message.jsonrpc!=='2.0')return mcpError(null,-32600,'Invalid Request',400);
  if(!('method' in message))return mcpError(null,-32600,('result' in message||'error' in message)?'Unexpected JSON-RPC response':'Invalid Request',400);
  const notification=!('id' in message);
  if(typeof message.method!=='string'||!message.method||(!notification&&!(typeof message.id==='string'||(typeof message.id==='number'&&Number.isFinite(message.id)))))return mcpError(null,-32600,'Invalid Request',400);
  // Without sessions the header is the only record of the negotiated version. A missing
  // header means 2025-03-26 under the 2025-11-25 transport rules, which is unsupported.
  // A plain -32600 (not the 2026-07-28 code -32022) lets dual-era clients fall back to initialize.
  const protocolVersion=request.headers.get('MCP-Protocol-Version');
  if(message.method!=='initialize'&&!MCP_PROTOCOL_VERSIONS.includes(protocolVersion))return mcpError(notification?null:message.id,-32600,(protocolVersion===null?'Missing':'Unsupported')+' MCP-Protocol-Version header. Supported: '+MCP_PROTOCOL_VERSIONS.join(', '),400);
  if(notification)return new Response(null,{status:202,headers:{'Cache-Control':'no-store'}});
  return mcpJson(await mcpDispatch(message,protocolVersion,env,execution));
 }catch{return mcpError(null,-32603,'Internal error',500);}
}
