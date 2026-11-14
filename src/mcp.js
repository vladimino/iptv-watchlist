// MCP endpoint (Streamable HTTP, JSON responses, stateless).
// Cloudflare Access application "IPTV MCP" (Managed OAuth) authenticates every
// request before it reaches the Worker. This module re-verifies the signed Access
// JWT. probe_read, probe_echo, feature_flags and prediction_validate do not touch storage. The prediction diagnostic
// tools only read the existing queue and one requested film. The other EPG and
// prediction tools call the existing Worker functions; they do not accept a URL,
// an R2 key, or an API path.
// AIR-58 is the Access prerequisite, AIR-60 is the internal continuation used by the EPG step,
// and AIR-62 is the later decision to enable Scheduled Tasks. This module does not enable them.
const MCP_PROTOCOL_VERSIONS=['2025-11-25','2025-06-18'];
const MCP_SERVER_INFO={name:'iptv-watchlist-probe',title:'IPTV Watchlist MCP',version:'0.3.0'};
const MCP_INSTRUCTIONS='IPTV Watchlist MCP. probe_read and probe_echo only test the connection and do not touch stored data. feature_flags reads the registered feature flags of the deployed Worker and changes nothing. Read epg_status, epg_pipeline_status, enrichment_schema, enrichment_profile, enrichment_runner, enrichment_queue and enrichment_status before writing. epg_sync_start then epg_sync_step use the returned runId and advance one existing step at a time. After stage is complete, read discovery.nextAction: continue means call epg_sync_step again with the same runId; wait means do not call before discovery.nextCatchUpAt (a server gate, not a scheduled run; discovery.nextScheduledRunAt is the hourly Scheduled Task trigger expected after it); stop means discovery is finished until the next EPG commit. ratingsPending does not request a Letterboxd retry. Personal ratings have their own pipeline: ratings_sync_status reads it; ratings_sync_start then ratings_sync_step with the returned runId advance it while nextAction is continue (wait: not before nextCatchUpAt; stop: done). It acts once ratings_storage_migrate has completed and ignores the retired RATINGS_PIPELINE binding; until then start and step answer not_migrated and the EPG commit does not read Diary. Call ratings_storage_migrate only with a separate owner approval. Do not enable a ratings Scheduled Task. prediction_start uses trigger scheduled or manual; already_running means stop and do not adopt that runId. prediction_batch_start (batch runner v2) takes the same lease and returns one manifest of up to 100 films with the profile, schema and metadata; it never runs beside a v5 run, manifest_too_large means nothing was created or shortened, and dryRun true writes nothing. prediction_next returns one film; generate the fingerprint and prediction in ChatGPT, call prediction_validate with the complete objects (it checks the enrichment_schema contract and stores nothing), fix every reported issue, then prediction_submit that one film. A submit rejection returns results[].validation.issues with the field path and code; fix that field for the following films. prediction_heartbeat renews the lease. prediction_complete only when the runner says mustComplete or a real quota, model, API or storage failure stops the run. Do not pass URLs, R2 keys or API paths. prediction_queue_overview, prediction_film_diagnostics and prediction_pending only read the existing queue and one requested film. They do not retry, reset or start a run. AIR-98. A formed prediction response is not proof the client received it. prediction_complete may include fault {origin, failedStep, providerErrorCode, httpStatus, receivedRequestId} only with an external or systemic stop reason; those values are caller-reported. Omit fault when the cause is unknown. A fault on a normal completion is rejected. receivedRequestId acknowledges only the matching step. AIR-88. Do not enable Scheduled Tasks; that is AIR-62. Prerequisites: AIR-58 authorization and AIR-60 one-chunk discovery.';
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
const MCP_CAPACITY={type:'object',properties:{remainingPercent:{type:'number',minimum:0,maximum:100}},additionalProperties:false,description:'Known remaining model capacity, 0–100. Omit when unknown.'};
const MCP_TOOLS=[
 {name:'probe_read',title:'Probe: read',description:'Use this to check that the IPTV Watchlist MCP connection and Cloudflare Access authorization work. Returns a fixed diagnostic report. It does not read watchlist, programme or any stored data. AIR-58.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:MCP_READ},
 {name:'probe_echo',title:'Probe: echo',description:'Use this to test a tool round trip. Returns the given short text unchanged. Nothing is stored. AIR-58.',inputSchema:{type:'object',properties:{text:{type:'string',minLength:1,maxLength:MCP_ECHO_MAX_CHARS,description:`Short test text, 1-${MCP_ECHO_MAX_CHARS} characters.`}},required:['text'],additionalProperties:false},annotations:MCP_READ},
 {name:'feature_flags',title:'Feature flags',description:'Read the registered Worker feature flags from the deployed environment in one call: for each flag whether it is set or absent, its literal value when it is made of known tokens (otherwise only its shape), whether the value is valid, the effective mode the code uses, and unmet requirements on other flags. Only the registered flags are read; no other binding, secret or token is returned. It does not read storage, change a flag or start anything. AIR-233.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:MCP_READ},
 {name:'epg_status',title:'EPG sync status',description:'Read the current EPG/watchlist sync stage, runId and remaining count. Same body as GET /api/status. It does not start sync. AIR-58; the following write steps depend on AIR-60, and AIR-62 enables the schedule.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:MCP_READ},
 {name:'epg_pipeline_status',title:'EPG pipeline status',description:'Read normalized EPG candidate, resolver and hot/cold queue counts. Same body as GET /api/enrichment/pipeline/status. It does not scan, resolve or write. view "operational" reads only the small Discovery records (authority, continuation, workflow, lease, last checkpoint) and stays readable while Discovery commits; the default "detailed" view reads the whole ledger under a snapshot fence and can answer discovery_fence during commits, which is not a failure of Discovery. AIR-58, AIR-60 and AIR-430.',inputSchema:{type:'object',properties:{view:{type:'string',enum:['operational','detailed'],description:'operational: bounded light status. detailed (default): full ledger statistics.'}},additionalProperties:false},annotations:MCP_READ},
 {name:'enrichment_schema',title:'Prediction schema',description:'Read the taste-profile and fingerprint schema the model must follow, including contract: the exact rules prediction_submit validates with (required fields, enum values, list sizes, lengths) and the issue codes it reports. Check a fingerprint and prediction against contract before prediction_submit. Same body as GET /api/enrichment/schema. Nothing is stored. AIR-58, AIR-152.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:MCP_READ},
 {name:'enrichment_profile',title:'Taste profile',description:'Read the published taste profile. Same body as GET /api/enrichment/profile. A missing profile means stop; this tool does not publish one. AIR-58.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:MCP_READ},
 {name:'enrichment_runner',title:'Prediction runner contract',description:'Read the current prediction runner contract before a run. Same body as GET /api/enrichment/runner. AIR-58. Enabling the hourly task is AIR-62.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:MCP_READ},
 {name:'enrichment_queue',title:'Prediction queue',description:'Read prediction queue counts and the last batch. Same body as GET /api/enrichment/queue/status. It does not reconcile or start a run. AIR-58.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:MCP_READ},
 {name:'enrichment_status',title:'Prediction status',description:'Read prediction runner state. Same body as GET /api/enrichment/status. An expired lease is projected as interrupted; the next prediction_start persists it. It does not start a run or deliver events. AIR-58; schedule enablement is AIR-62.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:MCP_READ},
 {name:'prediction_queue_overview',title:'Prediction queue overview',description:'Read the existing prediction queue: pending, eligible and deferred counts, the next retry time in UTC, coverage, and whether the queue, profile and published generation agree. A drained queue is distinct from one that is only waiting on retry. This does not refresh, retry or start a run. AIR-98.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:MCP_READ},
 {name:'prediction_film_diagnostics',title:'Film prediction diagnostics',description:'Read one film already in storage: fingerprint and prediction presence, whether the prediction matches the current profile, queue lane, retry summary, and index agreement. Missing facts stay unknown or not_recorded. This does not create a fingerprint or a prediction. AIR-98.',inputSchema:{type:'object',properties:{filmId:{type:'string',minLength:1,maxLength:80,pattern:'^[A-Za-z0-9_-]{1,80}$',description:'Film id, 1–80 letters, digits, "_" or "-".'}},required:['filmId'],additionalProperties:false},annotations:MCP_READ},
 {name:'prediction_validate',title:'Validate before submit',description:'Check the complete fingerprint and/or prediction you intend to submit against the same contract prediction_submit enforces (required fields, execution dimension enums, list sizes, lengths). An optional fingerprint.evidence map is checked only when that key is present; omit it to keep the legacy fingerprint. With a valid map, sourceBasis and sourceRefs may be omitted: the Worker derives them from the evidence (a supplied value must still equal that aggregate). Pass metadata, the film modelMetadata, only when that map cites metadata tokens. Returns success and valid (both true only when every supplied object was checked and has no issue; both false otherwise), contractVersion and, per object, checked and issues[{path, code}] from the closed vocabulary, for example fingerprint.execution.payoff invalid_enum. Nothing is stored and no run, lease, queue or film is read or touched: this is not a submit and does not count as a failure. Fix every issue, then call prediction_submit. AIR-152.',inputSchema:{type:'object',properties:{fingerprint:{type:'object',description:'The complete fingerprint object you intend to submit.'},prediction:{type:'object',description:'The complete prediction object you intend to submit.'},metadata:{type:'object',description:'Optional film modelMetadata. Pass it only when fingerprint.evidence cites metadata tokens. Omit it when the fingerprint has no evidence. This tool does not read storage.'}},additionalProperties:false},annotations:MCP_READ},
 {name:'prediction_batch_validate',title:'Validate a group before batch submit',description:'Read-only preflight of 1 to 10 candidates of a batch runner v2 group, run after you have generated them and before prediction_batch_submit. Each item is {filmId, fingerprint?, prediction?, assessment?, metadata?}: the complete objects you intend to submit (a prediction_only film has only a prediction; pass metadata, the film modelMetadata, only when its fingerprint.evidence cites metadata tokens). It runs the same validators and the same ADR 0129 derivation as prediction_validate and prediction_batch_submit, so a candidate that passes here is not refused for its fingerprint or prediction content at submit, and the issues are the same {path, code} of the closed vocabulary, per item, in request order, bound to the index and filmId you sent. A defect in one item never fails the others. It reads and writes no storage, run, lease, queue, profile, model, TMDB or EPG, does not check the frozen manifest, inputHash or live profile (prediction_batch_submit still does), and is not a submit. The optional assessment is checked exactly as the v2 submit checks it (closed keys, 3,000-byte serialized cap, source access, conflicts; issues use assessment.* paths, per item beside fingerprint and prediction); its verdict applies to prediction_batch_submit only, because prediction_validate and the v5 prediction_submit take no assessment. The request is refused whole above 10 items, 56 KiB (57,344 bytes) or with a repeated filmId. Fix only what real knowledge or sources support; otherwise report that film as failure parse_error in prediction_batch_submit. contractVersion names the schema contract. AIR-450.',inputSchema:{type:'object',properties:{items:{type:'array',minItems:1,maxItems:10,items:{type:'object',properties:{filmId:{type:'string',minLength:1,maxLength:80},fingerprint:{type:'object',description:'The complete fingerprint object you intend to submit.'},prediction:{type:'object',description:'The complete prediction object you intend to submit.'},assessment:{type:'object',description:'Optional v2 assessment you intend to submit beside the prediction.'},metadata:{type:'object',description:'Optional film modelMetadata, only when the fingerprint evidence cites metadata tokens.'}},required:['filmId'],additionalProperties:false}}},required:['items'],additionalProperties:false},annotations:MCP_READ},
 {name:'prediction_pending',title:'Prediction pending page',description:'Read one page of outstanding prediction film ids from the existing queue. filter is all, eligible or deferred. limit is 1–20. Pass the returned cursor for the next page of the same snapshot. This does not list storage or start a run. AIR-98.',inputSchema:{type:'object',properties:{filter:{type:'string',enum:['all','eligible','deferred']},limit:{type:'integer',minimum:1,maximum:20},cursor:{type:'string',minLength:1,maxLength:500,description:'Page token returned by the previous pending page.'}},required:['limit'],additionalProperties:false},annotations:MCP_READ},
 {name:'epg_sync_start',title:'Start EPG sync',description:'Start one EPG/watchlist sync, or return the active run when it is still within its freshness window. No arguments: the Worker chooses the Letterboxd and EPG sources. Returns runId, stage and remaining. Then call epg_sync_step. AIR-58. The EPG commit pauses discovery for a later step. AIR-62 enables the schedule.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:MCP_WRITE_WORLD},
 {name:'epg_sync_step',title:'Advance EPG sync one step',description:'Advance the runId from epg_sync_start by one existing step: one metadata batch, the EPG commit, one bounded step of the staged ledger publication (stage `seal`: the response carries a `seal` object and `nextAction` continue until the run is complete), or one discovery chunk. The response discovery object has state, remainingChunks and nextAction. continue: call again now with the same runId. wait: do not call before nextCatchUpAt, a server gate; nextScheduledRunAt is the expected hourly Scheduled Task trigger after it. stop: do not call until the next EPG commit. ratingsPending is not a reason to retry Letterboxd. This tool accepts no URL, R2 key, limit or chunk count. AIR-58 and AIR-60; AIR-62 enables the schedule.',inputSchema:{type:'object',properties:{runId:MCP_RUN_ID},required:['runId'],additionalProperties:false},annotations:MCP_WRITE_WORLD},
 {name:'ratings_sync_status',title:'Letterboxd ratings status',description:'Read the permanent separate Letterboxd ratings pipeline in one call: switch is always separate (the retired RATINGS_PIPELINE binding is ignored; feature_flags reports it), the effective pipeline (blocked, idle, running, isolated), the storage migration state (none, partial, complete, regressed), the run record with its lease and staleness, the Diary cursor and the removal queue counts. diary.enabled is the permanent Diary capability and does not prove a fetch or that the retired LETTERBOXD_DIARY_HISTORY binding is absent. removal.lookupEnabled is the permanent per-film lookup capability and does not prove a fetch or that the retired REMOVAL_RATING_LOOKUP binding is absent. Same body as GET /api/letterboxd/ratings/status. It writes nothing: it never closes a stale run, takes a lease or requests Letterboxd.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:MCP_READ},
 {name:'ratings_sync_start',title:'Start Letterboxd ratings run',description:'Start one ratings run of the permanent separate pipeline. The retired RATINGS_PIPELINE binding is ignored. trigger is scheduled or manual; clearIsolation true is accepted only with manual and only after the owner approved clearing an isolation. Returns runId, created, nextAction and reason: started (call ratings_sync_step with that runId), busy (a run is active; its runId is not returned), isolated or not_migrated (migration is not complete; nothing is written). A scheduled start has no minimum interval after the previous one. It does not request Letterboxd.',inputSchema:{type:'object',properties:{trigger:{type:'string',enum:['scheduled','manual']},clearIsolation:{type:'boolean'}},required:['trigger'],additionalProperties:false},annotations:MCP_WRITE},
 {name:'ratings_sync_step',title:'Advance Letterboxd ratings run',description:'Advance the runId from ratings_sync_start by one bounded step under a 3-minute lease. The Diary phase requests the first Diary page once per run and never requests page 2 or a later page. The retired LETTERBOXD_DIARY_HISTORY binding is not read. The removal phase, only while a rated legacy entry still needs its event scan, lists one page of existing removal events and links an exact film id, then writes stored ratings onto referenced events, then makes at most 5 per-film lookups for a film the Diary did not already rate. A confirmed stored rating for a film the current Diary page did not list is not requested, including after a new reference reopens the entry. A film that page lists without a rating is still looked up. A step probes at most five stored ratings and does not request a film it has not probed. A null or absent rating is not watched. The retired REMOVAL_RATING_LOOKUP binding is not read. It does not list events on a step with nothing left to link. nextAction continue: call again with the same runId. wait: another step holds the lease; do not call before nextCatchUpAt. stop: the run is finished, error or unknown, or the reply is run_mismatch, not_running, lease_lost or not_migrated. A 403 or 429 pauses the source; do not retry it. This tool accepts no URL, R2 key, page or limit.',inputSchema:{type:'object',properties:{runId:{...MCP_RUN_ID,maxLength:80,pattern:'^[A-Za-z0-9-]{1,80}$',description:'runId returned by ratings_sync_start. Not an R2 key.'}},required:['runId'],additionalProperties:false},annotations:MCP_WRITE_WORLD},
 {name:'ratings_storage_migrate',title:'Migrate ratings storage',description:'Owner-approved, one-time storage migration of the separate ratings pipeline: the removal queue to schema version 2 and the Diary cursor to its merge form, each by compare-and-swap, recorded in a durable migration witness. mode dry_run reports what apply would convert and writes nothing; apply converts and is idempotent. Refused while a ratings run holds a live record. A code revert after apply is not safe. Call only with a separate owner approval for that mode.',inputSchema:{type:'object',properties:{mode:{type:'string',enum:['dry_run','apply']}},required:['mode'],additionalProperties:false},annotations:MCP_WRITE},
 {name:'prediction_start',title:'Start prediction run',description:'Start the prediction runner with scope watchlist_all and mode queued. trigger is scheduled or manual. Pass capacity.remainingPercent only when the real value is known. already_running is success: stop and do not adopt that runId. busy means retry later. This does not generate a fingerprint or a prediction. AIR-58. AIR-62 enables the schedule.',inputSchema:{type:'object',properties:{trigger:{type:'string',enum:['scheduled','manual']},capacity:MCP_CAPACITY},required:['trigger'],additionalProperties:false},annotations:MCP_WRITE},
 {name:'prediction_batch_start',title:'Start batch prediction run (v2)',description:'Start a batch runner v2 run: one call returns one manifest of at most manifestSize eligible films (integer 1..100, default 100 when omitted; server ceiling limits.maxManifestFilms stays 100) with the full taste profile, the schema and versions, and each film\'s modelMetadata, work plan and (for prediction_only) stored fingerprint, plus the owned runId and lease epoch. The answer echoes manifestSize (requested) and filmsSelected (actual). No prediction_next, enrichment_profile or metadata call is needed afterwards. trigger is scheduled or manual. Pass capacity.remainingPercent only when the real value is known. already_running is success: stop and do not adopt that runId. manifest_too_large means nothing was created and nothing was shortened: stop and report bytes, limit and largestFilmBytes. batch_runner_requires_d1 means v2 does not run on this storage mode. dryRun true reads and writes nothing (no lease, run, queue or storage write) and returns the same manifest with runId null and a manifestHash; pin {filmIds} (dryRun only) selects exactly those queued films and must not exceed the effective manifestSize. This does not generate a fingerprint or a prediction and starts no Scheduled Task.',inputSchema:{type:'object',properties:{trigger:{type:'string',enum:['scheduled','manual']},capacity:MCP_CAPACITY,manifestSize:{type:'integer',minimum:1,maximum:100},dryRun:{type:'boolean'},pin:{type:'object',properties:{filmIds:{type:'array',items:{type:'string',minLength:1,maxLength:100},minItems:1,maxItems:100}},required:['filmIds'],additionalProperties:false}},required:['trigger'],additionalProperties:false},annotations:MCP_WRITE},
 {name:'prediction_batch_submit',title:'Submit a group of predictions (v2)',description:'Submit 1 to 10 films of a batch runner v2 run (see prediction_batch_start): each item is {filmId, fingerprint?, prediction, assessment?} or {filmId, failure:{kind, reason?, preflight?:{issues:[{path,code}]}}} (each issue is an object of exactly a closed-vocabulary field path and an issue code, at most 20, checked by the Worker; reason and the echoed last preflight issues are an optional closed-vocabulary claim of why the caller reports the film, stored as a caller claim and never as Worker validation; the optional assessment is the v2-only, separately stored per-film diagnostic of docs/reference/api/prediction-assessment.md: 3,000-byte cap, never an input to a rule, written once per prediction version, answered per film as assessment written, present, not_sent or not_applicable), with the runId and the lease epoch the start and every answer return. The Worker validates every film once, here, against the schema contract: no prediction_validate call is needed. Each film has its own result: created, recalculated, already_current, needs_regeneration (the taste profile moved under the run and this film is reached by the change), validation_failure (a sanitized stage and issue codes, retryable by the existing policy, never resubmitted in the run), blocked, deferred_budget, not_in_manifest or conflict. A group is not atomic: after a lost answer, a timeout or a 502 submit the same body again, committed films come back replayed. submit_in_flight means an earlier call of this run is still running: wait retryAfterMs and replay the same body. A group over 56 KiB is refused with nothing submitted: split it. profile.changed true carries the new profile and the filmIds to regenerate, and action complete means call prediction_complete with reason profile_changed. dryRun true validates and writes nothing (optional manifestHash, contract and per-item inputHash from a dry-run manifest). Do not use this tool on a v5 run.',inputSchema:{type:'object',properties:{runId:MCP_RUN_ID,epoch:{type:'integer',minimum:1},items:{type:'array',minItems:1,maxItems:10,items:{type:'object',properties:{filmId:{type:'string',minLength:1,maxLength:80},fingerprint:{type:'object'},prediction:{type:'object'},assessment:{type:'object'},failure:{type:'object',properties:{kind:{type:'string',enum:['parse_error','validation_error']},reason:{type:'string',enum:['preflight_validation_failed','insufficient_evidence','json_unparseable','request_too_large']},preflight:{type:'object',properties:{issues:{type:'array',maxItems:20,items:{type:'object'}}},required:['issues'],additionalProperties:false}},required:['kind'],additionalProperties:false},inputHash:{type:'string'}},required:['filmId'],additionalProperties:false}},dryRun:{type:'boolean'},manifestHash:{type:'string'},contract:{type:'object'}},required:['runId','epoch','items'],additionalProperties:false},annotations:MCP_WRITE},
 {name:'prediction_next',title:'Next prediction film',description:'Return the next film for an owned run, one film only. Generate its fingerprint or prediction in ChatGPT from the returned profile and schema. Do not invent a batch size. already complete or mustComplete means call prediction_complete instead of generating. HTTP 503 with code prediction_catalog_held is a wait, not a systemic stop: keep this runId, do not complete, retry this step while the 15-minute lease lasts (heartbeat ~every 10 minutes); if still held, leave the run for lease expiry, do not complete. AIR-58.',inputSchema:{type:'object',properties:{runId:MCP_RUN_ID,capacity:{...MCP_CAPACITY,properties:{...MCP_CAPACITY.properties,quotaAvailable:{type:'boolean'}}}},required:['runId'],additionalProperties:false},annotations:MCP_WRITE},
 {name:'prediction_submit',title:'Submit one prediction',description:'Submit exactly one film for the owned run. The Worker validates the fingerprint and prediction with the enrichment_schema contract. A rejected item is a retryable parse_error for that film and carries results[].validation {stage, issues[{path, code}]}, for example fingerprint.execution.payoff invalid_enum or fingerprint.moodLabels required: fix that field for the following films. For a malformed model response send failure.kind parse_error or validation_error and continue; one bad film does not end the run. HTTP 503 prediction_catalog_held can arrive after the film is already committed: keep the runId, do not complete, retry the identical payload (already_current, no second version). Wait at most one lease TTL with heartbeat; then leave the run. AIR-58, AIR-152.',inputSchema:{type:'object',properties:{runId:MCP_RUN_ID,items:{type:'array',minItems:1,maxItems:1,items:{type:'object',properties:{filmId:{type:'string',minLength:1,maxLength:80},fingerprint:{type:'object'},prediction:{type:'object'},failure:{type:'object',properties:{kind:{type:'string',enum:['parse_error','validation_error']}},required:['kind'],additionalProperties:false}},required:['filmId'],additionalProperties:false}}},required:['runId','items'],additionalProperties:false},annotations:MCP_WRITE},
 {name:'prediction_heartbeat',title:'Renew prediction lease',description:'Renew the 15-minute lease for an owned running prediction run. Call it before a long model generation and about every 10 minutes during one. AIR-58.',inputSchema:{type:'object',properties:{runId:MCP_RUN_ID},required:['runId'],additionalProperties:false},annotations:MCP_WRITE},
 {name:'prediction_complete',title:'Complete prediction run',description:'Finish the owned run. Omit reason when the queue is empty. For a batch_v2 run whose every selected manifest film is settled (created/recalculated/already_current or a recorded per-film retry) while ready films remain in the global queue, pass reason manifest_spent: that is a normal status:complete with a truthful Event, not time_budget and not «Прогнозы приостановлены». Unsubmitted or deferred_budget slots are refused. Otherwise pass a short reason such as quota, model_unavailable, api_error, storage_error or external_termination. HTTP 503 prediction_catalog_held is a wait: the run is not completed, no Event is written; retry complete later or leave the lease to expire, do not treat it as a systemic stop. Optional fault is caller-reported, only with that external or systemic reason, and does not prove a Worker failure. Omit it when the cause is unknown. A fault on a normal completion is rejected. Repeating a finished run does not create a second event. AIR-58. AIR-88. AIR-62 enables the schedule.',inputSchema:{type:'object',properties:{runId:MCP_RUN_ID,reason:{type:'string',minLength:1,maxLength:80},fault:{type:'object',additionalProperties:false,properties:{origin:{type:'string',enum:['worker_http','transport','model_provider','orchestrator','unknown']},failedStep:{type:'string',enum:['start','next','submit','heartbeat','complete']},providerErrorCode:{type:'string',minLength:1,maxLength:40},httpStatus:{type:'integer',minimum:100,maximum:599},receivedRequestId:{type:'string',minLength:1,maxLength:80}}}},required:['runId'],additionalProperties:false},annotations:{...MCP_WRITE,idempotentHint:true}},
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
async function mcpVerifyAccess(request,env){
 const forbidden={ok:false,status:403,message:'Forbidden'};
 const teamDomain=mcpTeamDomain(env.MCP_ACCESS_TEAM_DOMAIN),audience=typeof env.MCP_ACCESS_AUD==='string'?env.MCP_ACCESS_AUD.trim():'';
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
 return {ok:true};
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
function mcpCapacity(value,allowQuota){
 if(value===undefined)return true;
 if(!mcpIsObject(value))return false;
 const allowed=allowQuota?['remainingPercent','quotaAvailable']:['remainingPercent'];
 if(Object.keys(value).some(key=>!allowed.includes(key)))return false;
 if('remainingPercent' in value&&(typeof value.remainingPercent!=='number'||!Number.isFinite(value.remainingPercent)||value.remainingPercent<0||value.remainingPercent>100))return false;
 if('quotaAvailable' in value&&typeof value.quotaAvailable!=='boolean')return false;
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
 if(!mcpIsObject(item)||Object.keys(item).some(key=>!['filmId','fingerprint','prediction','failure'].includes(key)))return 'prediction_submit item accepts only filmId, fingerprint, prediction and failure.';
 if(typeof item.filmId!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(item.filmId))return '"filmId" must be 1–80 letters, digits, "_" or "-".';
 if(item.fingerprint!==undefined&&!mcpIsObject(item.fingerprint))return '"fingerprint" must be an object.';
 if(item.prediction!==undefined&&!mcpIsObject(item.prediction))return '"prediction" must be an object.';
 if(item.failure!==undefined&&(!mcpIsObject(item.failure)||Object.keys(item.failure).join()!=='kind'||!['parse_error','validation_error'].includes(item.failure.kind)))return '"failure.kind" must be parse_error or validation_error.';
 return null;
}
// One candidate, checked by the same validators prediction_validate, prediction_batch_validate and the submit paths use (ADR 0129 derivation included). Pure: no storage, no run, no lease.
function mcpCandidateReport(fingerprintValue,predictionValue,metadata,assessmentValue){
 const fingerprint=fingerprintValue===undefined?{checked:false,issues:[]}:{checked:true,issues:fingerprintIssues(deriveFingerprintSource(fingerprintValue,metadata),metadata)};
 const prediction=predictionValue===undefined?{checked:false,issues:[]}:{checked:true,issues:predictionIssues(predictionValue)};
 // The assessment verdict exists only for the v2 batch tools (ADR 0132): prediction_validate passes none and its report has no such field.
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
 if(params.name==='feature_flags'){
  // AIR-233: the allowlisted env bindings only, read by name; no storage, so it answers without a bucket binding.
  const rejected=mcpRejectFields(params.name,args,[]);if(rejected)return rejected;
  const report=featureFlagReport(env);
  return {result:{content:[{type:'text',text:JSON.stringify(report)}],structuredContent:report}};
 }
 if(params.name==='prediction_validate'){
  // AIR-152 preflight: the pure contract validators, no storage, no run or lease. Handled before the
  // storage check so that it answers even without a bucket binding.
  const rejected=mcpRejectFields(params.name,args,['fingerprint','prediction','metadata']);if(rejected)return rejected;
  if(args.fingerprint===undefined&&args.prediction===undefined)return {result:mcpToolError('prediction_validate needs "fingerprint", "prediction" or both: the complete objects you intend to submit.')};
  if(args.fingerprint!==undefined&&!mcpIsObject(args.fingerprint))return {result:mcpToolError('"fingerprint" must be an object.')};
  if(args.prediction!==undefined&&!mcpIsObject(args.prediction))return {result:mcpToolError('"prediction" must be an object.')};
  if(args.metadata!==undefined&&!mcpIsObject(args.metadata))return {result:mcpToolError('"metadata" must be an object.')};
  const {fingerprint,prediction,valid}=mcpCandidateReport(args.fingerprint,args.prediction,args.metadata);
  // success and valid name the same verdict: the preflight succeeded only when every supplied object
  // was checked and no issue was found. A tool error (bad arguments) carries neither field.
  const report={success:valid,valid,contractVersion:schemaContract().version,fingerprint,prediction,storage:'not_accessed',sideEffects:'none'};
  return {result:{content:[{type:'text',text:JSON.stringify(report)}],structuredContent:report}};
 }
 if(params.name==='prediction_batch_validate'){
  // AIR-450 batch preflight: the same pure validators as prediction_validate for 1 to 10 candidates, handled before the storage check, no storage, run, lease, queue or profile.
  const rejected=mcpRejectFields(params.name,args,['items']);if(rejected)return rejected;
  if(!Array.isArray(args.items)||args.items.length<1||args.items.length>10)return {result:mcpToolError('prediction_batch_validate accepts 1 to 10 items.')};
  const bytes=new TextEncoder().encode(JSON.stringify(args)).length;
  if(bytes>BATCH_RUNNER.submitMaxBodyBytes)return {result:mcpToolError('This request is '+bytes+' bytes, over the '+BATCH_RUNNER.submitMaxBodyBytes+' byte limit of one preflight (the MCP request limit is 65536). Nothing was checked: split the group and preflight it in smaller requests.')};
  const ids=args.items.filter(item=>mcpIsObject(item)&&typeof item.filmId==='string').map(item=>item.filmId);
  if(new Set(ids).size!==ids.length)return {result:mcpToolError('Each filmId may appear once in a request.')};
  const results=args.items.map(mcpBatchCandidate),valid=results.filter(result=>result.valid).length;
  const report={success:valid===results.length,valid:valid===results.length,contractVersion:schemaContract().version,results,counts:{items:results.length,valid,invalid:results.length-valid},storage:'not_accessed',sideEffects:'none'};
  return {result:{content:[{type:'text',text:JSON.stringify(report)}],structuredContent:report}};
 }
 if(!env.BUCKET)return {result:mcpToolError('Storage unavailable')};
 const fields={epg_status:[],epg_pipeline_status:['view'],enrichment_schema:[],enrichment_profile:[],enrichment_runner:[],enrichment_queue:[],enrichment_status:[],prediction_queue_overview:[],prediction_film_diagnostics:['filmId'],prediction_pending:['filter','limit','cursor'],epg_sync_start:[],epg_sync_step:['runId'],prediction_start:['trigger','capacity'],prediction_batch_start:['trigger','capacity','manifestSize','dryRun','pin'],prediction_batch_submit:['runId','epoch','items','dryRun','manifestHash','contract'],prediction_next:['runId','capacity'],prediction_submit:['runId','items'],prediction_heartbeat:['runId'],prediction_complete:['runId','reason','fault'],ratings_sync_status:[],ratings_sync_start:['trigger','clearIsolation'],ratings_sync_step:['runId'],ratings_storage_migrate:['mode']};
 const rejected=mcpRejectFields(params.name,args,fields[params.name]);if(rejected)return rejected;
 if(params.name==='prediction_queue_overview'||params.name==='prediction_film_diagnostics'||params.name==='prediction_pending'){
  try{
   const now=Date.now();
   if(params.name==='prediction_film_diagnostics'){
    if(typeof args.filmId!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(args.filmId))return {result:mcpToolError('"filmId" must be 1–80 letters, digits, "_" or "-".')};
    return mcpPayload(200,predictionFilmDiagnostic(await loadPredictionDiagnosticSnapshot(env,args.filmId),args.filmId,now));
   }
   if(params.name==='prediction_pending'){
    const query=predictionPendingQuery(args);
    if(query.error)return {result:mcpToolError(query.error)};
    const page=predictionPendingPage(await loadPredictionDiagnosticSnapshot(env),args,now);
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
 if(params.name==='ratings_sync_start'||params.name==='ratings_sync_step'||params.name==='ratings_storage_migrate'){
  try{const reply=await LetterboxdRatings.handle(env,params.name==='ratings_sync_start'?'start':params.name==='ratings_sync_step'?'step':'migrate',args);return reply.status===400?{result:mcpToolError(reply.body.error)}:mcpPayload(reply.status,reply.body);}
  catch(e){return {result:mcpToolError(String(e.message).slice(0,160))};}
 }
 if(params.name==='prediction_start'){
  if(args.trigger!=='scheduled'&&args.trigger!=='manual')return {result:mcpToolError('"trigger" must be scheduled or manual.')};
  if(!mcpCapacity(args.capacity,false))return {result:mcpToolError('"capacity" accepts only remainingPercent from 0 to 100.')};
  const body={scope:'watchlist_all',mode:'queued',trigger:args.trigger};if(args.capacity)body.capacity=args.capacity;
  return mcpDomain(()=>mcpEnrichment(env,execution,'POST','/api/enrichment/start',body));
 }
 if(params.name==='prediction_batch_start'){
  if(args.trigger!=='scheduled'&&args.trigger!=='manual')return {result:mcpToolError('"trigger" must be scheduled or manual.')};
  if(!mcpCapacity(args.capacity,false))return {result:mcpToolError('"capacity" accepts only remainingPercent from 0 to 100.')};
  if(args.manifestSize!==undefined&&(!Number.isInteger(args.manifestSize)||args.manifestSize<1||args.manifestSize>100))return {result:mcpToolError('"manifestSize" must be an integer from 1 to 100.')};
  if(args.dryRun!==undefined&&typeof args.dryRun!=='boolean')return {result:mcpToolError('"dryRun" must be true or false.')};
  const manifestCap=args.manifestSize===undefined?100:args.manifestSize;
  if(args.pin!==undefined){
   if(args.dryRun!==true)return {result:mcpToolError('"pin" is accepted only with dryRun true.')};
   if(!mcpIsObject(args.pin)||Object.keys(args.pin).some(key=>key!=='filmIds')||!Array.isArray(args.pin.filmIds)||!args.pin.filmIds.length||args.pin.filmIds.length>manifestCap||args.pin.filmIds.some(id=>typeof id!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(id)))return {result:mcpToolError('"pin" must be {filmIds}: 1 to '+manifestCap+' film ids (the effective manifestSize).')};
  }
  const body={scope:'watchlist_all',mode:'queued',trigger:args.trigger};if(args.capacity)body.capacity=args.capacity;if(args.manifestSize!==undefined)body.manifestSize=args.manifestSize;if(args.dryRun===true)body.dryRun=true;if(args.pin)body.pin={filmIds:args.pin.filmIds};
  return mcpDomain(()=>mcpEnrichment(env,execution,'POST','/api/enrichment/batch/start',body));
 }
 if(params.name==='prediction_batch_submit'){
  if(!mcpRunId(args.runId))return {result:mcpToolError('"runId" must be 1–100 letters, digits, "_" or "-".')};
  if(!Number.isInteger(args.epoch)||args.epoch<1)return {result:mcpToolError('"epoch" must be a positive integer: the lease epoch the start and every answer return.')};
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
   const issue=mcpSubmitItem(mcpIsObject(item)?rest:item);if(issue)return {result:mcpToolError(issue.replace('prediction_submit item','prediction_batch_submit item'))};
  }
  if(new Set(args.items.map(item=>item.filmId)).size!==args.items.length)return {result:mcpToolError('Each filmId may appear once in a group.')};
  const bytes=new TextEncoder().encode(JSON.stringify(args)).length;
  if(bytes>BATCH_RUNNER.submitMaxBodyBytes)return {result:mcpToolError('This group is '+bytes+' bytes, over the '+BATCH_RUNNER.submitMaxBodyBytes+' byte limit of one call (the MCP request limit is 65536). Nothing was submitted: split the group into smaller groups of films and submit them separately.')};
  const body={runId:args.runId,epoch:args.epoch,items:args.items};if(args.dryRun===true)body.dryRun=true;if(args.manifestHash!==undefined)body.manifestHash=args.manifestHash;if(args.contract!==undefined)body.contract=args.contract;
  return mcpDomain(()=>mcpEnrichment(env,execution,'POST','/api/enrichment/batch/submit',body));
 }
 if(params.name==='prediction_next'||params.name==='prediction_heartbeat'||params.name==='prediction_complete'){
  if(!mcpRunId(args.runId))return {result:mcpToolError('"runId" must be 1–100 letters, digits, "_" or "-".')};
 }
 if(params.name==='prediction_next'){
  if(!mcpCapacity(args.capacity,true))return {result:mcpToolError('"capacity" accepts only remainingPercent and quotaAvailable.')};
  const body={runId:args.runId,batchSize:1};if(args.capacity)body.capacity=args.capacity;
  return mcpDomain(()=>mcpEnrichment(env,execution,'POST','/api/enrichment/next',body));
 }
 if(params.name==='prediction_submit'){
  if(!mcpRunId(args.runId))return {result:mcpToolError('"runId" must be 1–100 letters, digits, "_" or "-".')};
  if(!Array.isArray(args.items)||args.items.length!==1)return {result:mcpToolError('prediction_submit accepts exactly one item.')};
  const issue=mcpSubmitItem(args.items[0]);if(issue)return {result:mcpToolError(issue)};
  return mcpDomain(()=>mcpEnrichment(env,execution,'POST','/api/enrichment/submit',{runId:args.runId,items:args.items}));
 }
 if(params.name==='prediction_heartbeat')return mcpDomain(()=>mcpEnrichment(env,execution,'POST','/api/enrichment/heartbeat',{runId:args.runId}));
 if(params.name==='prediction_complete'){
  if(args.reason!==undefined&&(typeof args.reason!=='string'||[...args.reason].length<1||[...args.reason].length>80||/[\u0000-\u001f]/.test(args.reason)))return {result:mcpToolError('"reason" must be 1–80 characters without control characters.')};
  if(args.fault!==undefined&&!mcpIsObject(args.fault))return {result:mcpToolError('"fault" must be an object.')};
  if(args.fault!==undefined&&Object.keys(args.fault).some(key=>!['origin','failedStep','providerErrorCode','httpStatus','receivedRequestId'].includes(key)))return {result:mcpToolError('"fault" accepts only origin, failedStep, providerErrorCode, httpStatus and receivedRequestId.')};
  const body={runId:args.runId};if(args.reason!==undefined)body.reason=args.reason;if(args.fault!==undefined)body.fault=args.fault;
  return mcpDomain(()=>mcpEnrichment(env,execution,'POST','/api/enrichment/complete',body));
 }
 return {error:'Unknown tool'};
}
async function mcpDispatch(message,protocolVersion,env,execution){
 const {id,method}=message,params=message.params===undefined?{}:message.params;
 const ok=result=>({jsonrpc:'2.0',id,result}),fail=(code,text)=>({jsonrpc:'2.0',id,error:{code,message:text}});
 if(!mcpIsObject(params))return fail(-32602,'Invalid params');
 if(method==='initialize'){
  if(typeof params.protocolVersion!=='string')return fail(-32602,'Invalid params: protocolVersion is required');
  const negotiated=MCP_PROTOCOL_VERSIONS.includes(params.protocolVersion)?params.protocolVersion:MCP_PROTOCOL_VERSIONS[0];
  return ok({protocolVersion:negotiated,capabilities:{tools:{listChanged:false}},serverInfo:MCP_SERVER_INFO,instructions:MCP_INSTRUCTIONS});
 }
 if(method==='ping')return ok({});
 if(method==='tools/list')return ok({tools:MCP_TOOLS});
 if(method==='tools/call'){
  if(typeof params.name!=='string'||!params.name)return fail(-32602,'Invalid params: tool name is required');
  const outcome=await mcpCallTool(params,protocolVersion,env,execution);
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
