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
const WRITE=/(\bBUCKET\.(?:put|delete)|\bbucket\.(?:put|delete)|\bsaveJSON|\bmergeStoredJSON|\.saveMutable|\.routeWrite|\bputJSON)\(/;
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
const PRIMITIVE=/((?:env\.)?\bBUCKET\.(?:put|delete|createMultipartUpload|resumeMultipartUpload)|\bbucket\.(?:put|delete|createMultipartUpload|resumeMultipartUpload)|\bsaveJSON|\bmergeStoredJSON|\.saveMutable|\.routeWrite|\bputStable|\bputKnownLength)\(/g;
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
// AIR-442: scope.values is the Map of one prediction request's own scope (src/enrichment.js, createRequestScope): what the step itself read or wrote, never storage.
const IN_MEMORY=new Set(['films','wanted','store.inflight','stillMissing','rows','reentryGroups.groups','map','latestGroups.groups','byTmdb','byLid','also','index','group','sequence','merged','scope.values','EPG_PHASE_SINKS','EPG_TRACE','skipUntil']);   // AIR-455: EPG_PHASE_SINKS; AIR-374 P3c: skipUntil is the per-binding WeakMap of the cached projector-route skip (src/canonical-discovery-admission-producer.js), never storage is the Map of the diagnostic canary's own run markers (src/worker.js), never storage
const receivers=new Map();
for(const [file,text] of texts)for(const m of text.matchAll(/([A-Za-z_$][A-Za-z0-9_$.]*)\.(put|delete|createMultipartUpload|resumeMultipartUpload)\(/g)){
 const who=m[1],method=m[2];
 const r2=who==='env.BUCKET'||who==='bucket'||who==='BUCKET';
 if(method==='put'||method==='createMultipartUpload'||method==='resumeMultipartUpload')assert.ok(r2,file+': .'+method+'( on an unknown receiver '+who+' (an alias of the R2 binding?)');
 else assert.ok(r2||IN_MEMORY.has(who),file+': .delete( on a receiver that is neither the R2 binding nor a known Map or Set: '+who);
}
const FILE_SITES={
 'src/admin/discovery-recovery.js':{r2:10,wrapper:0,dynamic:8},
 'src/admin/film-title-route.js':{r2:1,wrapper:0,dynamic:0},
 'src/admin/letterboxd-archive-apply.js':{r2:3,wrapper:0,dynamic:1},
 'src/admin/person-name-route.js':{r2:1,wrapper:0,dynamic:1},
 'src/epg-diagnostic.js':{r2:3,wrapper:0,dynamic:2},   // AIR-453 (ADR 0121): the guarded put and delete of the DIAGNOSTIC bucket and the identity put of `provision`; inert (no caller), a separate bucket, never a projector input
 'src/epg-diagnostic-run.js':{r2:4,wrapper:0,dynamic:1},   // AIR-455 (ADR 0121): the baseline writes and the cleanup of the DIAGNOSTIC bucket through the allowlisted context, the run document and the consumption marker; behind owner-only routes, inert without the diagnostic bindings, never a projector input
 'src/discovery-workflow.js':{r2:2,wrapper:0,dynamic:0},   // ADR 0118: +1 for the ledger of report-failure notices (events/discovery-report-faults.json, not a projector input)
 'src/discovery.js':{r2:8,wrapper:16,dynamic:4},
 // AIR-416: +2 wrapper sites, both mergeStoredJSON(env,EVENT_OUTBOX_KEY,...) (`enrichment/event-outbox.json`, the Predictions writer's index of undelivered run
 // events): not a projector input and not on a Discovery, admin-recovery or publication path.
 // Batch runner v2: +2 wrapper sites and +2 dynamic keys in batch_start, both the same object and key shape the v5 start writes: the create of `enrichment/sources/<runId>.json` (the metadata
 // of the run's films) and the interrupted record of a recovered earlier run (`enrichment/runs/<runId>.json`). Neither is a projector input or on a Discovery, admin-recovery or publication path.
 // Batch runner v2 batch_submit: +1 r2 site, +1 wrapper site and +1 dynamic key, all of the shape the v5 runner already writes: `runnerLeaseEdit` puts the runner lease object (the same key `runnerLease` puts, in the object
 // mode) and the per-film `enrichment/films/<id>/predictions.json` bundle (the key the v5 submit writes). Neither is a projector input or on a Discovery, admin-recovery or publication path.
 'src/enrichment.js':{r2:13,wrapper:47,dynamic:33}, // ADR 0132: +1 create-only put of the prediction assessment sidecar; it is no projector input (the projector reads film state, the bundle and the view index, never predictions/assessments/)
 'src/filter-presets.js':{r2:1,wrapper:0,dynamic:0},
 'src/letterboxd-diary.js':{r2:1,wrapper:1,dynamic:2},
 'src/letterboxd-facts.js':{r2:1,wrapper:0,dynamic:0},
 'src/letterboxd-rated-candidates.js':{r2:1,wrapper:0,dynamic:0},
 'src/letterboxd-ratings.js':{r2:1,wrapper:5,dynamic:5},
 'src/metadata-cache.js':{r2:1,wrapper:0,dynamic:0},
 'src/monitor.js':{r2:1,wrapper:0,dynamic:0},
 'src/owner-review-d1.js':{r2:2,wrapper:0,dynamic:0},
 'src/prediction-d1.js':{r2:5,wrapper:0,dynamic:0},
 'src/published-epg.js':{r2:2,wrapper:8,dynamic:8},
 // AIR-410: +1 for writeDiscoveryEvent, the create-only put of one `discovery` Events Log entry (events/items/..., not a projector input).
 // ADR 0118: writeDiscoveryEvent now has a second put, the compare-and-swap replacement of a report_failed notice by the report of the same hour (events/items/..., not a projector input).
 'src/worker.js':{r2:16,wrapper:47,dynamic:18},
};
const actualSites=Object.fromEntries([...perFile].sort().map(([f,v])=>[f,v]));
assert.deepEqual(actualSites,FILE_SITES,'the R2 write sites per file changed: look at the new site, classify it against the projector inputs, then update this table');
// The complete list of sites that name a key of a projector input that is not Discovery's. Each belongs to a path of its own domain.
const INPUT_WRITERS={
 "src/admin/film-title-route.js|env.BUCKET.put|OWNER_REVIEWS_KEY":{count:1,owner:'admin Film title route (owner review), its own route'},
 "src/enrichment.js|mergeStoredJSON|ENRICHMENT_KEY+'view-index.json'":{count:4,owner:'ratings and removal view-index maintenance, its own paths'},
 "src/metadata-cache.js|bucket.put|MIRROR_KEY":{count:1,owner:'metadata cache R2 mirror, its own domain'},
 "src/owner-review-d1.js|bucket.put|OWNER_REVIEWS_KEY":{count:1,owner:'owner-review D1 mirror, its own domain'},
 "src/owner-review-d1.js|env.BUCKET.put|OWNER_REVIEWS_KEY":{count:1,owner:'owner-review D1 mirror, its own domain'},
 "src/worker.js|saveJSON|'people.json'":{count:2,owner:'metadata sync steps (Persons)'},
 "src/worker.js|saveJSON|'titles.json'":{count:2,owner:'metadata sync steps (titles)'},
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
 // The generic writers: the key comes from the caller, which is classified above; an owned key is D1-routed.
 'saveJSON@src/worker.js':'generic writer: DiscoveryAuthority.routeWrite for an owned key, else R2 (callers classified)',
 // State that is not a projector input at all: the prediction queue, its D1 mirror, the removal queue.
 'writeQueue@src/prediction-d1.js':'prediction queue (not a projector input)',
 'mirror@src/prediction-d1.js':'prediction R2 mirror (not a projector input)',
 'putPredictionQueue@src/enrichment.js':'prediction queue (not a projector input)',
 'enqueueRemovalRefs@src/enrichment.js':'ratings removal queue (not a projector input)',
 'mergeStoredJSON@src/enrichment.js':'compare-and-swap writer of the removal queue and view-index maintenance (callers classified)',
 // Compatibility mirrors of D1-owned published documents: written by read-repair without the lease, never read by the projector under a
 // published D1 snapshot (section 3 below).
 'putStable@src/published-epg.js':'R2 compatibility mirror of a D1-owned published document',
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
 'copyEpgGeneration@src/worker.js':'under the publication lease',
 'persistWatchlist@src/worker.js':'under the publication lease',
 'planDiscoveryLedger@src/worker.js':'under the publication lease',
 'storePlannedDiscovery@src/worker.js':'under the publication lease',
 'writeLedgerSegment@src/worker.js':'under the publication lease',
 'putKnownLength@src/worker.js':'under the publication lease',
 'writeEvent@src/worker.js':'EPG event log (not a projector input)',
 'writeWorkflowState@src/discovery-workflow.js':'Workflow record: D1-routed, refused inside a held window by windowHeldGuard',
};
const reached=new Set([...writers(chunk),...writers(publication)]);
for(const key of reached)assert.ok(classes[key],'unclassified R2 writer reachable from Discovery or publication: '+key+' (classify it against the projector inputs)');
for(const key of Object.keys(classes))assert.ok(reached.has(key),'stale classification, no longer reachable as a writer: '+key);

// The projector's own input list, read from its source.
const projector=fs.readFileSync('src/d1-enrichment.js','utf8');
const inputs=new Set();
for(const line of projector.split('\n')){
 if(!/d1EnrichmentRead\(|d1EnrichmentDiscoveryRead\(/.test(line))continue;
 for(const m of line.matchAll(/'([^']+\.json)'/g))inputs.add(m[1]);
}
const notDiscovery=['metadata.json','titles.json','people.json','watchlist.json','letterboxd/diary/history.json','enrichment/view-index.json','letterboxd/admissions/verified-films.json','admin/owner-reviews.json'];
for(const name of notDiscovery)assert.ok(inputs.has(name),'the projector reads '+name);

// 2. Every function in the two closures that names a projector input that is not Discovery's, and what each one is. A new one fails.
const naming=set=>[...set.keys()].filter(key=>notDiscovery.some(name=>set.get(key).d.body.includes("'"+name+"'"))).sort();
const NAMING={
 'loadJSON@src/worker.js':'a read of published documents and other JSON; it does not write',
 'writeMirrors@src/published-epg.js':'writes those mirrors from the D1 document, idempotently',
 'persistWatchlist@src/worker.js':'publication path, under the lease',
 'sealPublishStep@src/worker.js':'publication path, under the sealStep lease',
};
const seen=new Set([...naming(chunk),...naming(publication)]);
for(const key of seen)assert.ok(NAMING[key],'a reachable function names a projector input and is not classified: '+key);
for(const key of Object.keys(NAMING))assert.ok(seen.has(key),'stale: '+key);

// 3. The lease-free path that writes a projector-input key is the EPG writer's mirror reconcile (repairMirrors,
// writeMirrors, putStable): it writes only R2 copies of a document that D1 owns. GET does not call it. The projector reads that document from the D1 published
// snapshot whenever one exists, and only otherwise from R2, so a mirror write cannot change what a run reads under a D1 published authority.
assert.match(projector,/published\?null:d1EnrichmentRead\(env,etags,'watchlist\.json'/,'watchlist is read from R2 only without a published D1 snapshot');
assert.match(projector,/published\?null:d1EnrichmentRead\(env,etags,epgGenerationKey\(runId,'programme\.json'\)/,'programme is read from R2 only without a published D1 snapshot');
assert.match(projector,/PublishedEpg\.authoritativeSnapshot\(env\)/,'the published snapshot is the D1 authority');
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
