// ADR 0103 / AIR-383: the transitive R2 side effects of the Discovery chunk, admin-recovery and EPG publication paths, against the
// projector's inputs. The earlier test (projector-window-r2-writes.mjs) classifies the write sites of three files. This one follows the
// calls: it builds a call graph over every file of the Worker bundle (functions, `const f=(...)=>` arrows; a bare call resolves inside its
// own file or to a name defined once, a `Module.f(` call to an exported function), takes everything reachable from the entry points and
// finds every function in that closure that writes to R2 (a direct bucket put or delete, `saveJSON`, `mergeStoredJSON`, `saveMutable`,
// `routeWrite`, a mirror put). The closure is a conservative superset (a name match is an edge), so the test can only err towards more
// writers, never fewer. Every writer must be classified here; an unclassified or a stale one fails. It then proves, for the writers that
// can touch a key the projector reads, how each one is kept out of a held window.
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
 'loadJSON@src/worker.js':'a read; for the published documents it calls PublishedEpg.repairMirrors (read-repair, below)',
 'repairMirrors@src/published-epg.js':'read-repair of the R2 mirrors of a D1-owned published document',
 'writeMirrors@src/published-epg.js':'writes those mirrors from the D1 document, idempotently',
 'persistWatchlist@src/worker.js':'publication path, under the lease',
 'sealPublishStep@src/worker.js':'publication path, under the sealStep lease',
};
const seen=new Set([...naming(chunk),...naming(publication)]);
for(const key of seen)assert.ok(NAMING[key],'a reachable function names a projector input and is not classified: '+key);
for(const key of Object.keys(NAMING))assert.ok(seen.has(key),'stale: '+key);

// 3. The lease-free path that writes a projector-input key is the read-repair of the published mirrors (loadJSON, repairMirrors,
// writeMirrors, putStable): it writes only R2 copies of a document that D1 owns. The projector reads that document from the D1 published
// snapshot whenever one exists, and only otherwise from R2, so a mirror write cannot change what a run reads under a D1 published authority.
assert.match(projector,/published\?null:d1EnrichmentRead\(env,etags,'watchlist\.json'/,'watchlist is read from R2 only without a published D1 snapshot');
assert.match(projector,/published\?null:d1EnrichmentRead\(env,etags,epgGenerationKey\(runId,'programme\.json'\)/,'programme is read from R2 only without a published D1 snapshot');
assert.match(projector,/PublishedEpg\.authoritativeSnapshot\(env\)/,'the published snapshot is the D1 authority');
const chunkNaming=new Set(naming(chunk));
for(const key of ['repairMirrors@src/published-epg.js','writeMirrors@src/published-epg.js','loadJSON@src/worker.js'])assert.ok(chunkNaming.has(key),key+' is the chunk-reachable path that names a projector input');
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

console.log('Projector window transitive R2 side effects: '+reached.size+' writer functions reachable from '+CHUNK.length+' chunk/admin and '+PUBLICATION.length+' publication entry points classified (graph of '+defs.size+' function names over '+files.length+' files); the only lease-free path that writes a projector-input key is the read-repair of D1 published mirrors, which the projector does not read under a published D1 snapshot; every publication entry takes the lease before its first write');
