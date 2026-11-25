// ADR 0103 / AIR-383: the R2 side effects of the Discovery chunk, admin-recovery and EPG publication paths, against the projector's inputs.
// Two independent parts, because a call graph by name is a best effort and not a proof:
//  1. A whole-bundle inventory of every R2 write site and wrapper call in `src/`, by text, with no graph and no reachability. The count of
//     sites per file is frozen, every receiver of `.put(` and every `.delete(` is accounted for (an alias or a new receiver fails), and the
//     complete list of sites that write a key naming a projector input that is not Discovery's is frozen with its owner. A new writer in any
//     file, in any call form that uses these primitives, fails here until it is looked at and classified.
//  2. A call graph over the bundle (functions and `const f=(...)=>` arrows; a bare call resolves inside its own file or to a name defined
//     once, a `Module.f(` call to an exported function). It does NOT see object or class methods, aliases, callbacks or dynamic dispatch
//     (it lists no unresolved callee), so its closure is not a superset of what can run; it is a best-effort map of the named paths. From
//     the chunk, admin and publication entry points it finds the writer functions on named paths and requires each to be classified.
// What neither part sees: a key built at run time, a write by a primitive that is not in the lists, and production.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const files=[];
(function walk(dir){for(const name of fs.readdirSync(dir)){const p=path.join(dir,name);if(fs.statSync(p).isDirectory())walk(p);else if(/\.js$/.test(name))files.push(p);}})('src');
const texts=new Map(files.map(f=>[f,fs.readFileSync(f,'utf8')]));

const DEF=/^(?:export\s+)?(?:(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(|const\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>)/gm;
const defs=new Map();
for(const [file,text] of texts){
 const starts=[];let m;DEF.lastIndex=0;
 while((m=DEF.exec(text)))starts.push({name:m[1]||m[2],at:m.index});
 starts.forEach((s,i)=>{
  const body=text.slice(s.at,i+1<starts.length?starts[i+1].at:text.length);
  if(!defs.has(s.name))defs.set(s.name,[]);
  defs.get(s.name).push({file,body,exported:/^export\s/.test(body)});
 });
}
const id=(name,def)=>name+'@'+def.file;
function closure(entries){
 const found=new Map(),queue=[];
 for(const name of entries){const list=defs.get(name);assert.ok(list,'entry point exists: '+name);for(const d of list)queue.push({name,d});}
 while(queue.length){
  const x=queue.pop(),key=id(x.name,x.d);
  if(found.has(key))continue;
  found.set(key,x);
  for(const m of x.d.body.matchAll(/(\.)?\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)){
   const list=defs.get(m[2]);if(!list)continue;
   for(const d of list){
    const same=d.file===x.d.file;
    if(m[1]?(d.exported||same):(same||list.length===1))queue.push({name:m[2],d});
   }
  }
 }
 return found;
}
const WRITE=/(\bBUCKET\.(?:put|delete)|\bbucket\.(?:put|delete)|\bsaveJSON|\bputStoredJson|\bmergeStoredJSON|\.saveMutable|\.routeWrite|\bputJSON)\(/;
const writers=set=>[...set.keys()].filter(key=>WRITE.test(set.get(key).d.body)).sort();

// The entry points. Chunk: the resolver chunk, the Workflow's chunk and the two admin routes that take the Discovery lease.
// Publication: the seal step and the three paths that take the lease to publish a generation.
const CHUNK=['advanceDiscovery','runWorkflowChunk','adminDiscoveryRecoveryRoute','adminDiscoveryReconsiderRoute'];
const PUBLICATION=['sealStep','stageSealedGeneration','publishD1Generation','publishEpgGeneration'];
const chunk=closure(CHUNK),publication=closure(PUBLICATION);

// ---- Part 1: the whole-bundle inventory (no graph).
const consts=new Map();
for(const [,text] of texts)for(const m of text.matchAll(/(?:^|\n)\s*(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*('[^'\n]*'|`[^`\n]*`)/g))if(!consts.has(m[1]))consts.set(m[1],m[2]);
const NOT_DISCOVERY=['metadata.json','titles.json','people.json','watchlist.json','letterboxd/diary/history.json','view-index.json','letterboxd/admissions/verified-films.json','owner-reviews.json'];
const PRIMITIVE=/((?:env\.)?\bBUCKET\.(?:put|delete|createMultipartUpload|resumeMultipartUpload)|\bbucket\.(?:put|delete|createMultipartUpload|resumeMultipartUpload)|\bsaveJSON|\bsaveCanonicalMirror|\bmergeStoredJSON|\.saveMutable|\.routeWrite|\bputStable|\bputKnownLength)\(/g;
const perFile=new Map(),inputSites=new Map();let siteCount=0;
function argsOf(text,from){let depth=0,i=from,start=from;const args=[];for(;i<text.length;i++){const c=text[i];if('([{'.includes(c))depth++;else if(')]}'.includes(c)){if(depth===0)break;depth--;}else if(c===','&&depth===0){args.push(text.slice(start,i));start=i+1;if(args.length>=2)break;}}args.push(text.slice(start,i));return args;}
for(const [file,text] of texts){
 let m;PRIMITIVE.lastIndex=0;
 while((m=PRIMITIVE.exec(text))){
  siteCount++;
  const r2=/BUCKET|bucket/.test(m[1]),args=argsOf(text,m.index+m[0].length);
  const keyArg=((r2||/putStable|putKnownLength/.test(m[1]))?args[0]:args[1]||'').replace(/\s+/g,'');
  const resolved=keyArg.replace(/[A-Za-z_$][A-Za-z0-9_$]*/g,x=>consts.get(x)||x);
  const dynamic=/[A-Za-z_$][A-Za-z0-9_$]*/.test(resolved.replace(/'[^']*'|`[^`]*`/g,''));
  const row=perFile.get(file)||{r2:0,wrapper:0,dynamic:0};
  row[r2?'r2':'wrapper']++;if(dynamic)row.dynamic++;perFile.set(file,row);
  if(NOT_DISCOVERY.some(n=>resolved.includes(n))){const k=file+'|'+m[1]+'|'+keyArg;inputSites.set(k,(inputSites.get(k)||0)+1);}
 }
}
// Every receiver of `.put(` is the R2 binding; every `.delete(` receiver is the R2 binding or a known in-memory Map or Set. An alias or a new
// receiver fails, so a write that the primitive list cannot see by name cannot arrive silently.
// AIR-402: index, group, sequence and merged are the in-memory lookups of the view build (src/domain/film-person-reader.js, orderedFilmIndex and its caller): Maps built from the view, never storage.
const IN_MEMORY=new Set(['films','wanted','store.inflight','stillMissing','rows','reentryGroups.groups','map','latestGroups.groups','byTmdb','byLid','also','index','group','sequence','merged','EPG_PHASE_SINKS','EPG_TRACE','skipUntil','matched','discovery','deferredKeys']);   // AIR-455: EPG_PHASE_SINKS; AIR-374 P3c: skipUntil is the per-binding WeakMap of the cached projector-route skip (src/canonical-discovery-admission-producer.js), never storage is the Map of the diagnostic canary's own run markers (src/worker.js), never storage // AIR-480 stage 1: matched and discovery are the local Maps of scanEPG, pruned after the stream when a slot has two owners. // AIR-492: deferredKeys is the in-memory set of this hop's fairness fences.
const receivers=new Map();
for(const [file,text] of texts)for(const m of text.matchAll(/([A-Za-z_$][A-Za-z0-9_$.]*)\.(put|delete|createMultipartUpload|resumeMultipartUpload)\(/g)){
 const who=m[1],method=m[2];
 const r2=who==='env.BUCKET'||who==='bucket'||who==='BUCKET';
 if(method==='put'||method==='createMultipartUpload'||method==='resumeMultipartUpload')assert.ok(r2,file+': .'+method+'( on an unknown receiver '+who+' (an alias of the R2 binding?)');
 else assert.ok(r2||IN_MEMORY.has(who),file+': .delete( on a receiver that is neither the R2 binding nor a known Map or Set: '+who);
}
const FILE_SITES={
 'src/admin/discovery-recovery.js':{r2:11,wrapper:0,dynamic:9},
 'src/admin/film-title-route.js':{r2:1,wrapper:0,dynamic:0},
 'src/admin/letterboxd-archive-apply.js':{r2:2,wrapper:0,dynamic:1}, // AIR-558: -1 write, the candidates-rollback marker of the retired archive rollback
 'src/admin/person-name-route.js':{r2:1,wrapper:0,dynamic:1},
 'src/canonical-producer-events.js':{r2:1,wrapper:0,dynamic:1},   // AIR-594 / ADR 0208: the immutable canonical_producer events (events/items/<reverse-timestamp>-<id>.json, create-only) put by the hourly drain from the D1 outcome rows; not a projector input; the hourly Producer reconcile only
 'src/catalog-poster-weekly.js':{r2:2,wrapper:0,dynamic:1},   // ADR 0179 (AIR-543): the weekly poster checkpoint (epg/catalog-poster-weekly.json) and the immutable catalog_posters events (events/items/<reverse-timestamp>-<id>.json); neither is a projector input
 'src/letterboxd-sync.js':{r2:1,wrapper:0,dynamic:1},   // ADR 0186: the create-only put of a slot Event (events/items/..., not a projector input)
 'src/discovery-workflow.js':{r2:2,wrapper:0,dynamic:1},   // ADR 0118: +1 for the ledger of report-failure notices (events/discovery-report-faults.json, not a projector input); AIR-595: that one site now names its key per ledger (the same object or events/discovery-report-faults-v2.json, also not a projector input), hence dynamic
 'src/discovery.js':{r2:8,wrapper:15,dynamic:3},
 // AIR-416: +2 wrapper sites, both mergeStoredJSON(env,EVENT_OUTBOX_KEY,...) (`enrichment/event-outbox.json`, the Predictions writer's index of undelivered run
 // events): not a projector input and not on a Discovery, admin-recovery or publication path.
 // Batch runner v2: +2 wrapper sites and +2 dynamic keys in batch_start, both the same object and key shape the v5 start writes: the create of `enrichment/sources/<runId>.json` (the metadata
 // of the run's films) and the interrupted record of a recovered earlier run (`enrichment/runs/<runId>.json`). Neither is a projector input or on a Discovery, admin-recovery or publication path.
 // Batch runner v2 batch_submit: +1 r2 site, +1 wrapper site and +1 dynamic key, all of the shape the v5 runner already writes: `runnerLeaseEdit` puts the runner lease object (the same key `runnerLease` puts, in the object
 // mode) and the per-film `enrichment/films/<id>/predictions.json` bundle (the key the v5 submit writes). Neither is a projector input or on a Discovery, admin-recovery or publication path.
 'src/enrichment.js':{r2:19,wrapper:39,dynamic:34}, // ADR 0196 (AIR-554): +2 r2 and +1 dynamic: the guarded bucket wrapper of the admission close forwards put and delete after the marker read (the same keys the callers chose, never a projector input); // AIR-553: +1 wrapper and +1 dynamic: the unchanged legacy manifest save now runs inside the timed `manifest_ready` stage (the same R2 write of the same key, not a projector input); the D1 branches add no R2 write, and the sources, stage, manifest and outbox keys stay classified as before, // // AIR-558: -1 r2 and -4 wrapper, the removed raw view-index writers (updateViewIndex CAS put and its mood-facet puts, ensureInitialRatings seed merge, the mood and fingerprint-view backfills); none a projector input, no other write changed. ADR 0193 / AIR-573: +1 r2, one create-only helper `writeCreateOnly` whose key is a parameter (the terminal outcome `enrichment/batch-start/<runId>.json` and the attempt marker `enrichment/batch-start/attempt/<runId>.json` of a deferred prediction start: Predictions run records, no reader among the projector inputs). AIR-552: -2 wrapper, the per-film mood-facet.json puts of updateViewIndex and the mood backfill (no reader, not a projector input). AIR-452: -6 wrapper and -3 dynamic, the retired v5 start/next/submit, the v5 start Event and the request object scope only they created (ADR 0167); none was a projector input. AIR-510: batch-manifest persist plus transferable batch-stage drain/hold; not a projector input. AIR-79: -3 wrapper and -3 dynamic, the three mergeStoredJSON(env,REMOVAL_LOOKUP_KEY,...) writes of the removed lookupRemovalRatings (the removal queue, not a projector input; the Ratings step keeps its own) AIR-548: +1 r2, the create-only park of a skipped-start Event under enrichment/stop-events/skipped-<requestId>.json (prediction Events outbox, not a projector input; ADR 0180). AIR-548 (index first, review of PR #805): +1 wrapper and +1 dynamic, clearEventOutbox, mergeStoredJSON(env,EVENT_OUTBOX_KEY,...) removing a delivered skipped-start entry from the same Predictions Events outbox index (not a projector input). AIR-548 (idempotent fallback, round 2): +1 r2, the compensating `BUCKET.delete` of an unindexed skipped-start record whose delivery failed (never a projector input). AIR-548 (round 3): +1 wrapper, recordSkippedStart now calls saveJSON for the `delivered` marker and writeEvent for the journal item itself (separate steps so an existing item is never treated as lost); the same Predictions Events outbox, never a projector input.
 'src/filter-presets.js':{r2:1,wrapper:0,dynamic:0},
 'src/letterboxd-diary.js':{r2:1,wrapper:1,dynamic:2},
 'src/letterboxd-facts.js':{r2:1,wrapper:0,dynamic:0},
 'src/letterboxd-rated-candidates.js':{r2:2,wrapper:0,dynamic:1}, // AIR-527: +1 write, the derived letterboxd/imports/registry.json (a droppable projection of candidate documents); not an enrichment projector input
 'src/letterboxd-ratings.js':{r2:1,wrapper:5,dynamic:5}, // AIR-604: +1 wrapper and +1 dynamic, the removal-queue pause extension (pausedUntil = max, REMOVAL_LOOKUP_KEY, an existing queue key, not a projector input). AIR-79 D-3: -1 wrapper and -1 dynamic, the migration witness write of the removed migrate(); the ratings queue and cursor writers are not projector inputs
 'src/metadata-cache.js':{r2:1,wrapper:0,dynamic:0},
 'src/monitor.js':{r2:1,wrapper:0,dynamic:0},
 'src/owner-review-d1.js':{r2:1,wrapper:0,dynamic:0}, // ADR 0162: -1 r2, the env.BUCKET.put of the retired mode-r2 commit; only the mirror put after a d1 commit remains
 'src/prediction-d1.js':{r2:3,wrapper:0,dynamic:0}, // ADR 0162: -2 r2, the mirror put of the retired revert toolchain (putSent) and its repair write; the D1 mirror put and the stand-in queue and lease puts remain
 // AIR-571 (C3, M1 adds putStandaloneWatchlistRoot with one more direct conditional put: r2 5): the root `watchlist.json` mirror has one guarded writer, putWatchlistRoot (two direct conditional puts of the root key: the first write of an absent object and the compare-and-swap of an existing one);
 // the two former putStable calls of that key (replacePart, writeMirrors) go through it, so wrapper and dynamic sites each lose one and the direct puts gain two.
 'src/published-epg.js':{r2:5,wrapper:7,dynamic:7},
 // AIR-410: +1 for writeDiscoveryEvent, the create-only put of one `discovery` Events Log entry (events/items/..., not a projector input).
 // ADR 0118: writeDiscoveryEvent now has a second put, the compare-and-swap replacement of a report_failed notice by the report of the same hour (events/items/..., not a projector input).
 // ADR 0145: +1 r2 put of `epg/seal/<runId>/publication.json` in `stageSealedGeneration` and +1 dynamic delete of that key in `sealQueueStep`
 // (the leftover `payload.json` delete stays). Neither object is a projector input; both sit on the publication path that already takes the lease.
 'src/worker.js':{r2:16,wrapper:58,dynamic:19}, // AIR-569: +1 wrapper, the run record sync.json saved when a Watchlist-pinned run replaces its events by the epg event alone, not a projector input. AIR-513: flushWatchlistEvent (including the failed-put mark) and the seal completion flush save sync.json, not a projector input. AIR-79: -1 wrapper, the saveJSON(env,'sync.json',run) of the removed ratingsPhase
};
const actualSites=Object.fromEntries([...perFile].sort().map(([f,v])=>[f,v]));
assert.deepEqual(actualSites,FILE_SITES,'the R2 write sites per file changed: look at the new site, classify it against the projector inputs, then update this table');
// The complete list of sites that name a key of a projector input that is not Discovery's. Each belongs to a path of its own domain.
const INPUT_WRITERS={
 "src/admin/film-title-route.js|env.BUCKET.put|OWNER_REVIEWS_KEY":{count:1,owner:'admin Film title route (owner review), its own route'},
 // AIR-558: the three view-index mergeStoredJSON sites (ratings and removal view-index maintenance) are removed with the raw writers; D1 owns the view index.
 "src/metadata-cache.js|bucket.put|MIRROR_KEY":{count:1,owner:'metadata cache R2 mirror, its own domain'},
 "src/owner-review-d1.js|bucket.put|OWNER_REVIEWS_KEY":{count:1,owner:'owner-review D1 mirror, its own domain'},
 "src/published-epg.js|bucket.put|WATCHLIST_KEY":{count:3,owner:'the guarded writers of the root watchlist.json mirror: putWatchlistRoot (EPG side, two puts, AIR-571 C3) and putStandaloneWatchlistRoot (Watchlist side, one put, AIR-571 M1); the Watchlist marker decides which of them may write'},
 "src/worker.js|saveCanonicalMirror|'people.json'":{count:2,owner:'metadata and EPG sync Persons, re-gated at put'},
 "src/worker.js|saveCanonicalMirror|'titles.json'":{count:2,owner:'metadata and EPG sync titles, re-gated at put'},
 "src/worker.js|saveJSON|'watchlist.json'":{count:3,owner:'EPG publication and watchlist persistence, under the publication lease'},
};
assert.deepEqual(Object.fromEntries([...inputSites].sort()),Object.fromEntries(Object.entries(INPUT_WRITERS).sort().map(([k,v])=>[k,v.count])),'the sites that write a non-Discovery projector input changed: classify the new one');
// None of the Discovery files writes a non-Discovery projector input by name; the read-repair mirror writer is the one dynamic-key writer
// of such a document, and it is classified in part 2.
for(const key of Object.keys(INPUT_WRITERS))assert.equal(/^src\/(discovery\.js|discovery-workflow\.js|admin\/discovery-recovery\.js)\|/.test(key),false,'a Discovery file names a non-Discovery projector input: '+key);
const inventory={sites:siteCount,files:perFile.size,inputSites:[...inputSites.values()].reduce((a,b)=>a+b,0)};

// ---- Part 2: the best-effort graph of the named paths.
const classes={
 // The Discovery files: every site is classified, with its guard, in projector-window-r2-writes.mjs.
 'advanceDiscovery@src/discovery.js':'discovery file',
 'attachWatchlistShowing@src/discovery.js':'discovery file',
 'observationShardPut@src/discovery.js':'discovery file',
 'releaseDiscoveryLease@src/discovery.js':'discovery file (the legacy R2 lease record)',
 'renewDiscoveryLease@src/discovery.js':'discovery file (the legacy R2 lease record)',
 'replaceContinuation@src/discovery.js':'discovery file',
 'resolveDiscoveryChunk@src/discovery.js':'discovery file',
 'resolvePagedDiscoveryChunk@src/discovery.js':'discovery file',
 'saveDiscoveredFilms@src/discovery.js':'discovery file',
 'saveScorePreview@src/discovery.js':'discovery file',
 'takeDiscoveryLease@src/discovery.js':'discovery file (the legacy R2 lease record)',
 'writeObservationIndex@src/discovery.js':'discovery file',
 'diCommitShard@src/admin/discovery-recovery.js':'admin recovery, after renewDiscoveryLease',
 'diConfirm@src/admin/discovery-recovery.js':'admin recovery, after renewDiscoveryLease',
 'diExecute@src/admin/discovery-recovery.js':'admin recovery, after renewDiscoveryLease',
 'diReconcileRunning@src/admin/discovery-recovery.js':'admin recovery, after renewDiscoveryLease',
 'diRetarget@src/admin/discovery-recovery.js':'admin recovery, after renewDiscoveryLease',
 'drActionWrite@src/admin/discovery-recovery.js':'admin recovery action receipt (not a projector input)',
 'drExecute@src/admin/discovery-recovery.js':'admin recovery, after renewDiscoveryLease',
 'drRefreshIndex@src/admin/discovery-recovery.js':'admin recovery observation index (not a projector input)',
 'peExecute@src/admin/discovery-recovery.js':'admin recovery policy-exclude receipt (not a projector input)',
 // The generic writers: the key comes from the caller, which is classified above; an owned key is D1-routed.
 'saveJSON@src/worker.js':'generic writer: DiscoveryAuthority.routeWrite for an owned key, else R2 (callers classified)',
 'putStoredJson@src/worker.js':'generic writer: titles.json/people.json freeze at BUCKET.put, else R2',
 // State that is not a projector input at all: the prediction queue, its D1 mirror, the removal queue.
 'writeQueue@src/prediction-d1.js':'prediction queue (not a projector input)',
 'mirror@src/prediction-d1.js':'prediction R2 mirror (not a projector input)',
 'putPredictionQueue@src/enrichment.js':'prediction queue (not a projector input)',
 'enqueueRemovalRefs@src/enrichment.js':'ratings removal queue (not a projector input)',
 'mergeStoredJSON@src/enrichment.js':'compare-and-swap writer of the removal queue and view-index maintenance (callers classified)',
 // Compatibility mirrors of D1-owned published documents: written by read-repair without the lease, never read by the projector under a
 // published D1 snapshot (section 3 below).
 'putStable@src/published-epg.js':'R2 compatibility mirror of a D1-owned published document',
 'putWatchlistRoot@src/published-epg.js':'R2 compatibility mirror of the root watchlist.json: read, marker check after the read, conditional put (AIR-571 C3); never read by the projector under a published D1 snapshot',
 // The publication and seal paths: each entry takes the Discovery lease before its first write (section 4 below).
 'sealStep@src/worker.js':'publication entry, lease first',
 'stageSealedGeneration@src/worker.js':'publication entry, lease first',
 'publishD1Generation@src/worker.js':'publication entry, lease first',
 'publishEpgGeneration@src/worker.js':'publication entry, lease first',
 'sealCheckpoint@src/worker.js':'under the sealStep lease',
 'sealFinalizeStep@src/worker.js':'under the sealStep lease',
 'sealPublishStep@src/worker.js':'under the sealStep lease',
 'sealQueueStep@src/worker.js':'under the sealStep lease',
 'flushEpgEvent@src/worker.js':'EPG event log and the run record (sync.json), not projector inputs; under the sealStep lease, finishSync or the complete-run continuation',
 'flushWatchlistEvent@src/worker.js':'watchlist event log and the run record (sync.json), not projector inputs; under the sealStep lease, finishSync or the complete-run continuation',
 'copyEpgGeneration@src/worker.js':'under the publication lease',
 'persistWatchlist@src/worker.js':'under the publication lease',
 'persistScan@src/worker.js':'publication scan: Letterboxd facts plus D1 retention cursor on sync.json; under the lease; not a projector input',
 'planDiscoveryLedger@src/worker.js':'under the publication lease',
 'storePlannedDiscovery@src/worker.js':'under the publication lease',
 'writeLedgerSegment@src/worker.js':'under the publication lease',
 'putKnownLength@src/worker.js':'under the publication lease',
 'writeEvent@src/worker.js':'EPG event log (not a projector input)',
 'writeWorkflowState@src/discovery-workflow.js':'Workflow record: D1-routed, refused inside a held window by windowHeldGuard',
 // ADR 0179 (AIR-543). The daily poster cron is reached by name from the Worker's scheduled entry; none of these is a projector input.
 'catalogPosterApply@src/discovery.js':'poster-only copy write of the owner route and of the weekly sweep (the shared core); takes the resolver lease and re-checks the generation before every write (ADR 0048, ADR 0179)',
 'catalogPosterNegativesSave@src/discovery.js':'the poster negative index epg/catalog-poster-negatives.json (not a projector input), by compare-and-swap: the route, the weekly sweep and the admission seed, which runs inside the chunk that holds the lease',
 'writeCheckpoint@src/catalog-poster-weekly.js':'the weekly poster checkpoint epg/catalog-poster-weekly.json (not a projector input), by compare-and-swap; the daily cron entry only',
 'deliver@src/catalog-poster-weekly.js':'immutable catalog_posters events under events/items/ (not a projector input) and the outbox mark; the daily cron entry only',
 'putEvent@src/letterboxd-sync.js':'immutable slot Events (ratings, watchlist) under events/items/ by a create-only put (not a projector input); reached only from the Letterboxd Sync delivery, never from Discovery or publication (the name is matched, the call graph is not)',
};
const reached=new Set([...writers(chunk),...writers(publication)]);
for(const key of reached)assert.ok(classes[key],'unclassified R2 writer reachable from Discovery or publication: '+key+' (classify it against the projector inputs)');
for(const key of Object.keys(classes))assert.ok(reached.has(key),'stale classification, no longer reachable as a writer: '+key);

// AIR-537 slice 3: the enrichment projector that read these R2 objects is retired, so its input list can no longer be read from its
// source. The list is frozen here as it stood when the runner was removed; the objects stay protected from unfenced Discovery writes.
const inputs=new Set(['watchlist.json','programme.json','metadata.json','titles.json','people.json','discovered-films.json','epg/discovery-resolution.json','letterboxd/diary/history.json','enrichment/view-index.json','letterboxd/admissions/verified-films.json']);
// ADR 0162: admin/owner-reviews.json is no longer a projector input; the projector reads owner reviews from D1 only.
const notDiscovery=['metadata.json','titles.json','people.json','watchlist.json','letterboxd/diary/history.json','enrichment/view-index.json','letterboxd/admissions/verified-films.json'];
for(const name of notDiscovery)assert.ok(inputs.has(name),'the projector reads '+name);

// 2. Every function in the two closures that names a projector input that is not Discovery's, and what each one is. A new one fails.
const naming=set=>[...set.keys()].filter(key=>notDiscovery.some(name=>set.get(key).d.body.includes("'"+name+"'"))).sort();
const NAMING={
 'loadJSON@src/worker.js':'a read of published documents and other JSON; it does not write',
 'catalogMetadataRead@src/worker.js':'AIR-569: a READ of the canonical metadata (D1 reader in d1 mode, else the metadata.json mirror) for the identity of a new Watchlist member; it writes nothing',
 'putStoredJson@src/worker.js':'frozen titles.json/people.json put after epgStepGuard; other keys are ordinary R2 JSON',
 'saveJSON@src/worker.js':'generic writer: the root watchlist.json key is routed to the one guarded writer (PublishedEpg.putWatchlistRoot) through saveWatchlistRoot (AIR-571 C3); every other key as before',
 'writeMirrors@src/published-epg.js':'writes those mirrors from the D1 document, idempotently',
 'persistWatchlist@src/worker.js':'publication path, under the lease',
 'persistScan@src/worker.js':'publication scan path; reads view-index to plan watchlist false retention, writes no frozen mirror',
 'sealPublishStep@src/worker.js':'publication path, under the sealStep lease',
 'buildPredictionQueue@src/enrichment.js':'reads watchlist.json only while the programme snapshot is unsealed, for membership; it writes neither watchlist nor a projector input',
};
const seen=new Set([...naming(chunk),...naming(publication)]);
for(const key of seen)assert.ok(NAMING[key],'a reachable function names a projector input and is not classified: '+key);
for(const key of Object.keys(NAMING))assert.ok(seen.has(key),'stale: '+key);

// 3. The lease-free path that writes a projector-input key is the EPG writer's mirror reconcile (repairMirrors,
// writeMirrors, putStable): it writes only R2 copies of a document that D1 owns. GET does not call it. (AIR-537 slice 3: the projector that
// read those objects is retired; the published EPG is D1-owned and the mirrors are compatibility copies.)
const chunkNaming=new Set(naming(chunk));
assert.ok(chunkNaming.has('loadJSON@src/worker.js'),'loadJSON still names a projector input as a read');
assert.equal(chunkNaming.has('repairMirrors@src/published-epg.js'),false,'GET and the chunk path no longer call repairMirrors');
assert.equal(chunkNaming.has('writeMirrors@src/published-epg.js'),false,'writeMirrors is the publication path, not the chunk');
for(const key of ['persistWatchlist@src/worker.js','sealPublishStep@src/worker.js'])assert.equal(chunkNaming.has(key),false,key+' is not reachable from a chunk or an admin route, only from the publication paths');

// 4. The publication entries take the Discovery lease (through leaseOrWindowBusy or acquireLease, which the window refuses) before their
// first write, so a requested or a held window turns them into the typed busy before any R2 object is touched.
const ACQUIRE=/leaseOrWindowBusy\(|takeDiscoveryLease\(|acquireDiscoveryLease\(|DiscoveryAuthority\.acquireLease\(/;
const FIRST_WRITE=/\bsaveJSON\(|\bBUCKET\.(?:put|delete)|\bputStable\(|\bsealPublishStep\(|\bsealFinalizeStep\(|\bsealQueueStep\(|\bsealLedgerStep\(|\bsealCatalogStep\(|\bcopyEpgGeneration\(|\bpersistWatchlist\(|\bwriteEvent\(|\bmergeStoredJSON\(/;
for(const name of PUBLICATION){
 for(const d of defs.get(name)){
  const body=d.body.replace(/\/\/[^\n]*/g,'');
  const lease=body.search(ACQUIRE),write=body.search(FIRST_WRITE);
  assert.ok(lease>=0,name+' takes the Discovery lease');
  assert.ok(write<0||lease<write,name+' takes the lease before its first write');
 }
}
// The admin functions that put the shared decisions in R2 hold the lease and renew it right before that put.
for(const [name,list] of defs){
 for(const d of list){
  if(d.file!=='src/admin/discovery-recovery.js'||!/BUCKET\.put\(DR_RESOLUTION_KEY/.test(d.body))continue;
  const body=d.body.replace(/\/\/[^\n]*/g,'');
  const acquire=body.search(/acquireDiscoveryLease\(env\)/),renew=body.search(/renewDiscoveryLease\(env,lease\)/),put=body.search(/BUCKET\.put\(DR_RESOLUTION_KEY/);
  assert.ok(acquire>=0&&acquire<renew&&renew<put,name+' acquires the lease and renews it before the shared-decisions put');
 }
}

console.log('Projector window R2 side effects: whole-bundle inventory of '+inventory.sites+' write sites in '+inventory.files+' files with the '+inventory.inputSites+' sites that name a non-Discovery projector input frozen; best-effort named-path graph: '+reached.size+' writer functions from '+CHUNK.length+' chunk/admin and '+PUBLICATION.length+' publication entry points classified; GET does not repair D1 published mirrors; every publication entry takes the lease before its first write');
