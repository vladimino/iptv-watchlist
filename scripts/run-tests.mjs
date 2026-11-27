import {appendFileSync,lstatSync,mkdtempSync,readdirSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {availableParallelism,tmpdir} from 'node:os';
import path from 'node:path';
import {selectSuite} from './test-classification.mjs';
import {onPath,resolveSqliteCli} from './sqlite-cli.mjs';
import {appendRecord,contentTree,recordPath} from './test-pass-record.mjs';

// AIR-378. Runs every self-contained test file in its own Node process (process isolation is kept), a bounded number at a time.
//
//   npm test                          the core suite: min(6, ceil(1.5 x CPUs)) files at a time (AIR-408: the suite waits more than it computes)
//   npm test -- --suite non-functional  mutant-kill checks and runner wall-clock checks (also TEST_SUITE); the nightly workflow runs this
//   npm test -- --suite all           core, then the non-functional suite (split files run in both, with the matching callbacks); a full pass on an unchanged
//                                     working tree is recorded for the pre-push hook (AIR-668, scripts/test-pass-record.mjs; IPTV_TEST_PASS_RECORD=0 skips it)
//   npm test -- --serial              one file at a time, in name order (the previous behaviour)
//   npm test -- --jobs 2              at most 2 files at a time (also TEST_JOBS=2)
//   npm test -- --timeout-ms 120000   per-file limit (also TEST_TIMEOUT_MS), default 300000
//   npm test -- --suite all --isolate-measurements  non-functional measurement files run alone after the parallel phase (the pre-push hook; also TEST_ISOLATE_MEASUREMENTS=1)
//   npm test -- --shard 1/3           this part of the selected suite only (also TEST_SHARD); CI runs the core suite as three jobs (AIR-418)
//
// AIR-583. Every run creates one private temporary root `iptv-run-XXXXXX` inside the OS temp directory and hands it to every test file as TMPDIR, TMP and TEMP
// (and IPTV_TEST_RUN_ROOT), so what the files and their tools (SQLite, Miniflare, workerd, Wrangler) create in os.tmpdir() lands there. The runner deletes exactly that
// directory as the last step, after its children are stopped, on pass, failure, timeout and handled SIGINT/SIGTERM, and keeps the exit code. It never globs, never
// follows a symlink and never touches anything outside the root; SIGKILL and a crash cannot be handled. IPTV_TEST_KEEP_TMP=1 keeps the root for debugging.
//
// A failing, timed-out or signalled file is never lost: it is named with its exit code or signal and its full stdout and stderr, the runner
// stops starting new files, lets the running ones finish and exits non-zero. Files in SERIAL_ONLY run alone, after the parallel phase.

// Historical integration fixtures contain downloaded production snapshots and
// are intentionally not part of the public repository.
export const FIXTURE_DEPENDENT=new Set([
 'filters-window.mjs',
 'names.mjs',
 'sources.mjs',
 'synopsis.mjs',
 'titles.mjs',
 'unscheduled.mjs',
]);
// Files that must not share the machine with others. local-dev-smoke boots a Wrangler dev server twice: it probes a free port and then reuses
// it (another process could take it in between), and it is slow and CPU-heavy, with its own boot timeouts.
const SERIAL_ONLY=new Set([
 'local-dev-smoke.mjs',
 // Its sqlite session calls wait at most 20 s for an answer of up to several MB; beside five other CPU-bound files that bound was exceeded on the post-merge
 // run 43186573244 (12 Nov 2026), twice, at the same line. Alone it takes about 7 s. Run alone after the parallel phase; no timeout or assertion changed.
 'sqlite-session-semantics.mjs',
]);
// AIR-374: approximate cost of the heavier files, in weight units of one shard's share (about 660 per shard): the mean over 30 shard jobs (ten CI runs of 12 Nov 2026 on the three-shard plan, docs/evidence/ci/test-suite-air-374-ci-weights-recalibration-2026-11-12.md) of each file's share of its job's summed file time, scaled to 630, so a fast or a slow runner does not skew a file; every file that costs 2 or more has its own entry; DEFAULT_WEIGHT 0.5 covers the rest, whose mean is 0.5.
// AIR-374 P8: after that calibration the entries of the files of 12 or more whose cost fell (docs/evidence/ci/test-suite-air-374-cheaper-tests-2026-11-12.md) were scaled by the ratio of the system-wide CPU seconds of one run before and after; events-type-filter (11 s of waiting, now 0.7 s) is left to DEFAULT_WEIGHT.
// The two serial-only files are weighted by their solo time (mean 9.9 s and 7.2 s) divided by the 0.233 s of wall one unit holds, because they run after the parallel phase and add their whole duration to a shard's wall time.
// Two uses, both scheduling only: the files start heaviest first, and the files are dealt to the shards by greedy longest-processing-time assignment (every file has DEFAULT_WEIGHT unless listed), so
// the shards carry about the same total weight and not the same number of files. A name that no longer exists, or a new slow file that is missing here, changes the wall time and nothing else:
// every file still runs exactly once, in exactly one shard.
// AIR-374 S4-4: the driver entries started as local estimates (about 65 s of wall each). CI run 43538794105 measured canonical-producer-driver-mutation-b.mjs at 175.1 s on shard 1, and that shard's Run tests step at 240.4 s. Weight 40 moves that half onto the lighter shard; the other half stays at its estimate.
// AIR-374 CI recalibration of 14 Nov 2026 (docs/evidence/ci/test-suite-air-374-ci-weights-recalibration-2026-11-14.md): every entry is the mean share of its job's summed file time over 30 shard jobs (ten successful CI runs of 14 Nov 2026, 411 files), scaled to 630, by the method of the recalibration of 12 Nov; the two serial-only files keep their solo-time weights. FIRST_SHARD_OFFSET and FIRST_SHARD_HEAVY_CREDIT were refit on the same data. It replaces the local estimates for the S4-2, S4-4 and later entries.
// AIR-374 S4-2 (migration 0020): the four new entries (the two schema tests and the two preflight tests) are LOCAL estimates, not CI means: wall time of one `npm test -- --jobs 3` run on a shared machine (7.4 s, 36.8 s, 1.2 s and 9.2 s) scaled by the ratio of the entries of the existing files of the same kind; a CI recalibration replaces them.
export const WEIGHTS={
 'canonical-producer-driver-mutation-b.mjs':98,
 'canonical-producer-driver-mutation.mjs':78,
 'generation-stage.mjs':67,
 'film-person-e6-measure-mutation.mjs':58,
 'epg-r2-known-length.mjs':54,
 'epg-producer-m2b-reader-mutation.mjs':51,
 'discovery-decisions-read.mjs':43,
 'sqlite-session-semantics.mjs':42,
 'generation-stage-withheld.mjs':38,
 'canonical-producer-schema-mutation.mjs':34,
 'prediction-batch-start.mjs':33,
 'discovery-seal-publish.mjs':32,
 'projector-view-parity.mjs':32,
 'canonical-producer-run-mutation.mjs':31,
 'local-dev-smoke.mjs':31,
 'discovery-bounded-drain.mjs':27,
 'epg-producer-m2b-mutation.mjs':27,
 'canonical-dictionary-producer-mutation.mjs':23,
 // AIR-662: local estimate (about 3 s solo for 12 mutants of a 1 s functional file), not a CI mean; scheduling only.
 'film-localization-projection-mutation.mjs':2,
 'prediction-batch-submit.mjs':22,
 'canonical-catalog-titles-mutation.mjs':20,
 'canonical-differential-mutation.mjs':20,
 'canonical-person-mutation-producer-mutation.mjs':20,
 'd1-backfill.mjs':19,
 'canonical-discovery-admission-producer-mutation.mjs':18,
 'canonical-epg-person-producer-mutation.mjs':18,
 'canonical-receipts-mutation.mjs':18,
 'prediction-queue-budget.mjs':18,
 'run-tests-runner.mjs':18,
 'canonical-receipted-writers-mutation.mjs':15,
 'discovery-chunk-budget.mjs':14,
 'd1-enrichment.mjs':13,
 'canonical-film-external-ids-producer-mutation.mjs':12,
 'discovery-production.mjs':12,
 'canonical-catalog-reader-mutation.mjs':11,
 'canonical-producer-adapters-mutation.mjs':11,
 'canonical-producer-driver.mjs':11,
 'epg-orchestration.mjs':11,
 'epg-workflow-rollover.mjs':10,
 'prediction-authority-scope.mjs':11,
 'canonical-epg-producer-mutation.mjs':10,
 'discovery-archive-import.mjs':10,
 'offline-importer.mjs':10,
 'canonical-producer-store-mutation.mjs':9,
 'migration-export.mjs':9,
 'canonical-person-state-mutation.mjs':8,
 'canonical-receipted-writers.mjs':8,
 'discovery-admission-packed.mjs':8,
 'discovery-seal-throughput.mjs':8,
 'film-person-0019-preflight-mutation.mjs':8,
 'film-person-0020-preflight-mutation.mjs':8,
 'get-write-audit.mjs':8,
 'prediction-queue-cas.mjs':8,
 'canonical-receipts.mjs':6,
 'discovery-status-memory.mjs':6,
 'epg-producer-dry-run-mutation.mjs':6,
 'generation-stage-faults.mjs':6,
 'prediction-domain-production.mjs':6,
 'prediction-queue-discovery-independence.mjs':6,
 'prediction-hot-reconcile-same-generation.mjs':6,
 'canonical-film-writers-mutation.mjs':5,
 'canonical-producer-schema.mjs':5,
 'published-epg-production.mjs':5,
 'r2-snapshot-export.mjs':5,
 'canonical-differential.mjs':4,
 'canonical-epg-person-producer.mjs':4,
 'deferred-completion-status.mjs':4,
 'discovery-authority.mjs':4,
 'discovery-bounded-d1-rehearsal.mjs':4,
 'discovery-ledger-install.mjs':4,
 'discovery-pipeline-d1-status.mjs':4,
 'epg-status-ledger-mode.mjs':4,
 'metadata-cache.mjs':4,
 'migration-pattern-limit.mjs':4,
 'prediction-domain.mjs':4,
 'prediction-dry-run-isolation.mjs':4,
 'prediction-manifest-size.mjs':4,
 'prediction-overlay-index.mjs':4,
 'tmdb-tv-runtime.mjs':4,
 'admin-letterboxd-archive-api.mjs':3,
 'canonical-dictionary-producer.mjs':3,
 'canonical-person-state.mjs':3,
 'discovery-bounded-fence.mjs':3,
 'discovery-chunk-memory.mjs':3,
 'discovery-ledger-split.mjs':3,
 'epg-producer-m2b-synthetic.mjs':3,
 'film-person-authority.mjs':3,
 'film-person-e6-measure.mjs':3,
 'fingerprint-source-derivation.mjs':3,
 'owner-review-d1.mjs':3,
 'published-epg.mjs':3,
 'scheduled-task-prompt-v2.mjs':3,
 'canonical-catalog-reader.mjs':2,
 'canonical-catalog-titles.mjs':2,
 'canonical-epg-producer.mjs':2,
 'canonical-handoff-readiness.mjs':2,
 'canonical-person-mutation-producer.mjs':2,
 'canonical-read-model.mjs':2,
 'cron-schedule-simulation.mjs':2,
 'discovery-operational-status.mjs':2,
 'lifecycle-diagnostics.mjs':2,
 'prediction-assessment.mjs':2,
 'projector-window.mjs':2,
 'ratings-orchestration.mjs':2,
 'ratings-run.mjs':2,
};
// AIR-494: core-only scheduling costs, mean GitHub Actions `ok <file> (<s>s)` over 12 successful CI/CD runs after AIR-490 (fit set; docs/evidence/ci/air-494-core-shard-recalibration-2026-11-15.md). Rounded seconds, entries of 2 or more; the two serial-only files keep solo-time / 0.233 s per unit so they pay for the tail they add after the parallel phase. Mutation files are not in this map: the required jobs run `--suite core`. Unlisted core files keep DEFAULT_WEIGHT.
export const CORE_WEIGHTS={
 'generation-stage.mjs':55,
 'discovery-decisions-read.mjs':44,
 'epg-r2-known-length.mjs':42,
 'sqlite-session-semantics.mjs':38,
 'generation-stage-withheld.mjs':34,
 'local-dev-smoke.mjs':32,
 'projector-view-parity.mjs':26,
 'discovery-seal-publish.mjs':24,
 'run-tests-runner.mjs':22,
 'prediction-batch-start.mjs':21,
 'prediction-queue-budget.mjs':21,
 'discovery-bounded-drain.mjs':19,
 'd1-backfill.mjs':17,
 'canonical-producer-driver.mjs':14,
 'offline-importer.mjs':14,
 'discovery-production.mjs':13,
 'd1-enrichment.mjs':12,
 'epg-orchestration.mjs':12,
 'prediction-batch-submit.mjs':12,
 'discovery-archive-import.mjs':11,
 'discovery-chunk-budget.mjs':11,
 'discovery-seal-throughput.mjs':11,
 'migration-export.mjs':11,
 'film-person-reader.mjs':10,
 'prediction-authority-scope.mjs':10,
 'canonical-receipted-writers.mjs':9,
 'get-write-audit.mjs':9,
 'prediction-queue-cas.mjs':9,
 'prediction-manifest-size.mjs':8,
 'prediction-queue-discovery-independence.mjs':8,
 'prediction-hot-reconcile-same-generation.mjs':8,
 'discovery-admission-packed.mjs':7,
 'migration-pattern-limit.mjs':7,
 'canonical-producer-schema.mjs':6,
 'canonical-receipts.mjs':6,
 'generation-stage-faults.mjs':6,
 'prediction-domain-production.mjs':6,
 'r2-snapshot-export.mjs':6,
 'deferred-completion-status.mjs':5,
 'discovery-pipeline-d1-status.mjs':5,
 'epg-producer-m2b-synthetic.mjs':5,
 'film-person-e6-measure.mjs':5,
 'prediction-batch-start-parity-lib.mjs':5,
 'prediction-overlay-index.mjs':5,
 'published-epg-production.mjs':5,
 'tmdb-tv-runtime.mjs':5,
 'admin-letterboxd-archive-api.mjs':4,
 'canonical-dictionary-producer.mjs':4,
 'canonical-differential.mjs':4,
 'canonical-epg-person-producer.mjs':4,
 'discovery-authority.mjs':4,
 'discovery-bounded-d1-rehearsal.mjs':4,
 'discovery-chunk-memory.mjs':4,
 'discovery-ledger-install.mjs':4,
 'discovery-status-memory.mjs':4,
 'epg-path-a-feasibility.mjs':4,
 'epg-status-ledger-mode.mjs':4,
 'metadata-cache.mjs':4,
 'prediction-batch-start-budget.mjs':4,
 'prediction-batch-start-parity.mjs':4,
 'prediction-domain.mjs':4,
 'scheduled-task-prompt-v2.mjs':4,
 'canonical-catalog-titles.mjs':3,
 'canonical-person-mutation-producer.mjs':3,
 'canonical-person-state.mjs':3,
 'discovery-ledger-split.mjs':3,
 'discovery-operational-status.mjs':3,
 'film-person-authority.mjs':3,
 'letterboxd-baseline-chunks.mjs':3,
 'owner-review-d1.mjs':3,
 'prediction-dry-run-isolation.mjs':3,
 'projector-window.mjs':3,
 'published-epg.mjs':3,
 'ratings-orchestration.mjs':3,
 'ratings-run.mjs':3,
 'admin-letterboxd-apply.mjs':2,
 'admin-shell.mjs':2,
 'canonical-catalog-reader.mjs':2,
 'canonical-discovery-admission-producer.mjs':2,
 'canonical-epg-producer.mjs':2,
 'canonical-film-external-ids-producer.mjs':2,
 'canonical-film-writers.mjs':2,
 'canonical-handoff-readiness.mjs':2,
 'canonical-producer-adapters.mjs':2,
 'canonical-producer-store.mjs':2,
 'canonical-producer-chain.mjs':3,
 'canonical-producers.mjs':2,
 'canonical-read-model.mjs':2,
 'canonical-readiness-classes.mjs':2,
 'cron-schedule-simulation.mjs':2,
 'discovery-bounded-fence.mjs':2,
 'discovery-events.mjs':2,
 'discovery-fast-recovery.mjs':2,
 'discovery-fence-collision.mjs':2,
 'discovery-fence-hourly-lockstep.mjs':2,
 'discovery-ledger-archive.mjs':2,
 'discovery-revalidation.mjs':2,
 'discovery-seal-resume.mjs':2,
 'epg-commit-durable-enqueue.mjs':2,
 'epg-event-publication.mjs':2,
 'epg-mirror-reconciliation.mjs':2,
 'epg-priority-gate.mjs':2,
 'epg-producer-m2b.mjs':2,
 'epg-run-certificate.mjs':2,
 'evidence-json-paths.mjs':2,
 'film-admission.mjs':2,
 'film-person-0019-preflight.mjs':2,
 'film-person-0020-preflight.mjs':2,
 'film-sync-state.mjs':2,
 'fingerprint-source-derivation.mjs':2,
 'item-failures.mjs':2,
 'letterboxd-rated-candidates.mjs':2,
 'lifecycle-diagnostics.mjs':2,
 'metadata-cache-production.mjs':2,
 'prediction-caller-failure-claim.mjs':2,
 'projector-window-epg.mjs':2,
 'ratings-cursor-merge.mjs':2,
};
export const DEFAULT_WEIGHT=0.5;
// Weight the first shard is dealt less than the others: its job (`Test and build`) also runs the documentation governance check, the build, the Discovery Workflow bundle validation and the artifact upload outside `Run tests`. AIR-480 stage 4b raised this from 20 to 80 after shard 1 of PR #639 measured 237.5 s. AIR-490: that 240 s figure is no longer a merge gate. AIR-494 keeps 80 for both maps: with core costs in seconds it leaves shard 1 about 7 s of job overhead (mean extra 24.4 s against 17.4 s on the plain shard jobs) without emptying it. The nightly map still uses it so the two heaviest mutation files stay off shard 1. It is a starting load in the deal, so shard 1 ends about this much lighter than shards 2 and 3.
export const FIRST_SHARD_OFFSET=80;
// AIR-374 contention cohort (see planTests): the files that compete for the CPU are the mutation files (any weight) and every other file of at least HEAVY_MIN_WEIGHT units, about 9% of the files and 55% of the weight. They are dealt before the rest by "pressure": a file's weight, times HEAVY_MUTATION_PRESSURE for a mutation file, which re-runs a production module against many mutants in child processes and so takes far more of a 4 vCPU runner than its weight says (a fit of the 36 shard jobs of 12 runs gives about 0.65 s of `Run tests` per mutation unit against 0.06 to 0.09 s per unit of any other weight). Shard 1 starts FIRST_SHARD_HEAVY_CREDIT pressure units ahead: with 117 s in the last run against 158 s and 187 s it has the most headroom, so it gets the largest cohort share; its total weight is still dealt less by FIRST_SHARD_OFFSET.
export const HEAVY_MIN_WEIGHT=20;
export const HEAVY_MUTATION_PRESSURE=6;
export const FIRST_SHARD_HEAVY_CREDIT=160;
// AIR-480: 160 (was 100) so shard 1's extra FIRST_SHARD_OFFSET does not also collect the heaviest mutation file by pressure. AIR-490 left this constant for the nightly plan. AIR-494: the core plan has no mutation files, so that credit dumped the remaining heavy core files onto shards 2 and 3. CORE_FIRST_SHARD_HEAVY_CREDIT is the core-only credit, refit on the same 12-run set; the nightly plan still uses FIRST_SHARD_HEAVY_CREDIT.
export const CORE_FIRST_SHARD_HEAVY_CREDIT=10;
const MUTATION=/-mutation\.mjs$/;
// A mutant-kill file, including a split part such as canonical-producer-driver-mutation-b.mjs (MUTATION above does not match the part).
const MUTANT_KILL=/-mutation(-[a-z0-9]+)?\.mjs$/;
// Output of one stream is kept whole up to HEAD_LIMIT+TAIL_LIMIT characters. Beyond that the beginning and the END are kept and the middle is
// dropped with an explicit notice: the last lines of a failing file (its assertion and stack) are the ones that matter.
export const HEAD_LIMIT=1024*1024;
export const TAIL_LIMIT=3*1024*1024;
const KILL_GRACE_MS=3000;
const FORCE_WAIT_MS=2000;
// True once no process of any of these process groups exists any more (ESRCH), polled for at most `limit` ms.
async function groupsGone(pids,limit){
 const gone=pid=>{try{process.kill(-pid,0);return false;}catch(error){return error.code==='ESRCH';}};
 const deadline=Date.now()+limit;
 for(;;){
  if(pids.every(gone))return true;
  if(Date.now()>=deadline)return false;
  await new Promise(resolve=>setTimeout(resolve,50));
 }
}

// The run root. `parent` is the real path of the directory it was created in; removal re-checks both before it deletes anything.
export function createRunRoot(base=tmpdir()){
 const parent=realpathSync(base);
 return {parent,root:mkdtempSync(path.join(parent,'iptv-run-'))};
}
// Files and bytes under `root`, symlinks counted as entries and never followed.
export function measureTree(root){
 let files=0,bytes=0;
 const walk=directory=>{
  for(const entry of readdirSync(directory,{withFileTypes:true})){
   const full=path.join(directory,entry.name);
   if(entry.isDirectory()){walk(full);continue;}
   files++;
   try{bytes+=lstatSync(full).size;}catch{}
  }
 };
 walk(root);
 return {files,bytes};
}
// Deletes the run root and nothing else. rmSync removes a symlink inside the tree as a link and does not enter its target. The root itself must still be a
// real directory (not a symlink) named iptv-run-* directly inside `parent`, otherwise nothing is deleted. Never throws: a failure is returned as `error`.
export function removeRunRoot({parent,root}){
 try{
  if(path.dirname(root)!==parent||!path.basename(root).startsWith('iptv-run-'))return {removed:false,error:`refused: ${root} is not a run root inside ${parent}`};
  let stat;
  try{stat=lstatSync(root);}catch(error){if(error.code==='ENOENT')return {removed:true,files:0,bytes:0};throw error;}
  if(stat.isSymbolicLink()||!stat.isDirectory())return {removed:false,error:`refused: ${root} is not a plain directory`};
  let counts={files:0,bytes:0};
  try{counts=measureTree(root);}catch{}
  rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:50});
  return {removed:true,...counts};
 }catch(error){return {removed:false,error:String(error.message||error)};}
}

function option(args,name,env,fallback){
 const index=args.indexOf('--'+name);
 if(index>=0&&index+1<args.length)return args[index+1];
 return process.env[env]!==undefined&&process.env[env]!==''?process.env[env]:fallback;
}
function positive(value,label,fallback){
 if(value===undefined||value===null)return fallback;
 const number=Number(value);
 if(!Number.isInteger(number)||number<1){console.error(`${label} must be a positive integer, got "${value}"`);process.exit(2);}
 return number;
}
const seconds=ms=>(ms/1000).toFixed(1)+'s';

// Bounded capture of one stream: the first HEAD_LIMIT characters, then a rolling window of the last TAIL_LIMIT characters.
export function capture(){
 let head='',tail='',dropped=0;
 return {
  push(chunk){
   if(head.length<HEAD_LIMIT){
    const room=HEAD_LIMIT-head.length;
    head+=chunk.slice(0,room);
    chunk=chunk.slice(room);
    if(!chunk)return;
   }
   tail+=chunk;
   if(tail.length>2*TAIL_LIMIT){dropped+=tail.length-TAIL_LIMIT;tail=tail.slice(-TAIL_LIMIT);}
  },
  // Characters that are in neither the head nor the kept tail. Counted from `dropped` as well as from the tail's length: a trim leaves the tail
  // at exactly TAIL_LIMIT, so the length alone does not say that anything was dropped.
  omitted(){return dropped+Math.max(0,tail.length-TAIL_LIMIT);},
  text(){
   const lost=dropped+Math.max(0,tail.length-TAIL_LIMIT);
   if(lost===0)return head+tail;
   return head+`\n... [${lost} characters omitted] ...\n`+tail.slice(-TAIL_LIMIT);
  },
 };
}

// `shard` is {index, count} (index from 1) or null for the whole suite. AIR-374: the files are ordered heaviest first (WEIGHTS, then name) and dealt one by one to the shard with the least weight so far
// (ties to the lowest index), so the split is the same whichever shard asks and every file is in exactly one shard, whatever the count.
export function planTests({directory='tests',fixtureDependent=FIXTURE_DEPENDENT,serialOnly=SERIAL_ONLY,shard=null,weights,firstShardOffset=FIRST_SHARD_OFFSET,heavyMinWeight=HEAVY_MIN_WEIGHT,heavyCredit,mutationPressure=HEAVY_MUTATION_PRESSURE,suite='core',isolateMeasurements=false}={}){
 const listed=readdirSync(directory).filter(file=>file.endsWith('.mjs')&&!fixtureDependent.has(file)).sort();
 const all=selectSuite(listed,directory,suite);
 // The pre-push hook asks for this (--isolate-measurements). A non-functional file that is not a mutant-kill check measures wall time, memory or a latency budget,
 // and beside five CPU-bound mutation files on a laptop those measurements miss their bounds although the file passes alone (25 Nov 2026: film-person-reader's 8 s
 // index bound and discovery-chunk-budget's hop comparison failed in turn on three hooked pushes of an unrelated branch). Such files then run alone, after the
 // parallel phase, like the serial-only files; the mutation files keep running in parallel. The nightly workflow and CI do not pass it and are unchanged.
 if(isolateMeasurements&&suite==='non-functional')serialOnly=new Set([...serialOnly,...all.filter(file=>!MUTANT_KILL.test(file))]);
 const core=suite==='core';
 weights=weights??(core?CORE_WEIGHTS:WEIGHTS);
 heavyCredit=heavyCredit??(core?CORE_FIRST_SHARD_HEAVY_CREDIT:FIRST_SHARD_HEAVY_CREDIT);
 const weight=file=>weights[file]??DEFAULT_WEIGHT;
 const ordered=[...all].sort((a,b)=>weight(b)-weight(a)||(a<b?-1:1));
 const owner=new Map();
 if(shard){
  const load=Array(shard.count).fill(0);
  if(shard.count>1)load[0]=firstShardOffset;
  // A serial-only file adds its whole solo time after the parallel phase, so two of them never share a shard (while there is a free shard): the least loaded shard that holds no serial-only file yet. That keeps the rule true whatever a later WEIGHTS entry does to the rest of the deal.
  const serialHolders=new Set();
  const deal=file=>{
   const serial=serialOnly.has(file)&&serialHolders.size<load.length;
   let best=-1;
   for(let i=0;i<load.length;i++)if(!(serial&&serialHolders.has(i))&&(best<0||load[i]<load[best]))best=i;
   owner.set(file,best);load[best]+=weight(file);
   if(serialOnly.has(file))serialHolders.add(best);
  };
  // The contention cohort is dealt first, heaviest pressure first, each file to the shard with the least pressure (ties: the least loaded), shard 1 starting `heavyCredit` ahead. Evidence (docs/evidence/ci/test-suite-air-374-ci-weights-recalibration-2026-11-12.md): the mutation files starve each other on the 4 vCPU runner (205 s against 103 s for the same weight, runs 43179499163 and 43180054837); spreading only the nine heaviest files by count left the CPU-bound middle of the suite together in shard 2, which took 177 s and then 187 s of `Run tests` (runs 43272848716 and 43275433514) for a balanced plan while shard 1 took 117 to 124 s. The remaining files then fill every shard up to the same total weight (shard 1 less by `firstShardOffset`).
  const pressureOf=file=>weight(file)*(MUTATION.test(file)?mutationPressure:1);
  const pressure=Array(shard.count).fill(0);
  if(shard.count>1)pressure[0]=-heavyCredit;
  const dealPressure=file=>{
   let best=0;
   for(let i=1;i<load.length;i++)if(pressure[i]<pressure[best]||(pressure[i]===pressure[best]&&load[i]<load[best]))best=i;
   owner.set(file,best);load[best]+=weight(file);pressure[best]+=pressureOf(file);
  };
  const cohort=ordered.filter(file=>!serialOnly.has(file)&&(MUTATION.test(file)||weight(file)>=heavyMinWeight)).sort((a,b)=>pressureOf(b)-pressureOf(a)||(a<b?-1:1));
  for(const file of cohort)dealPressure(file);
  for(const file of ordered)if(!owner.has(file))deal(file);
 }
 const mine=list=>shard?list.filter(file=>owner.get(file)===shard.index-1):list;
 const plan={parallel:mine(ordered.filter(file=>!serialOnly.has(file))),serial:mine(ordered.filter(file=>serialOnly.has(file)).sort())};
 return {...plan,total:plan.parallel.length+plan.serial.length,suite:all.length};
}
// "2/3" is shard 2 of 3. Anything else is refused: a typo must not silently run the whole suite, or nothing.
export function parseShard(value){
 if(value===undefined||value===null||value==='')return null;
 const match=/^([1-9]\d*)\/([1-9]\d*)$/.exec(String(value));
 if(!match||Number(match[1])>Number(match[2]))return undefined;
 return {index:Number(match[1]),count:Number(match[2])};
}

// The sqlite3 shell behind the D1 stand-in is checked once per run (scripts/sqlite-cli.mjs): it must run its standard input and stop at the statement that fails under
// -bail. macOS ships a sqlite3 that does neither reliably (24 Nov 2026: 3.54.0 ran nothing with `-cmd` and `-bail`, and runs the rest of a line after a failed statement),
// so the first shell that passes, the sqlite3 of PATH or else Homebrew's keg-only sqlite, is put first in PATH for every file and named in IPTV_SQLITE3_VERIFIED, which
// lets the files skip the same check; without one the run stops here instead of failing every database test one by one. CI's Ubuntu sqlite3 passes as it is.
function prepareSqlite(){
 const verified=process.env.IPTV_SQLITE3_VERIFIED;
 if(verified&&onPath('sqlite3')===verified)return;
 const found=resolveSqliteCli();
 if(!found.command){console.error('No usable sqlite3 shell for the test suite:\n - '+found.problems.join('\n - '));process.exit(2);}
 if(found.fallback)console.log(`sqlite3 for this run: ${found.command}\n - `+found.problems.join('\n - '));
 process.env.PATH=found.directory+path.delimiter+(process.env.PATH||'');
 process.env.IPTV_SQLITE3_VERIFIED=found.command;
}
async function main(){
 const args=process.argv.slice(2);
 const directory=option(args,'dir','TEST_DIR','tests');
 const serialOnly=new Set((option(args,'serial-only','TEST_SERIAL_ONLY','')||'').split(',').filter(Boolean));
 const requestedSerial=args.includes('--serial')||process.env.TEST_JOBS==='1';
 // AIR-408: most files wait (timers, child processes, workerd) more than they compute, so a few more files than CPUs run at once. Measured on 4 vCPU:
 // jobs 4 = 149 s, 6 = 119 s, 8 = 115 s (docs/evidence/ci/test-suite-air-408-2026-11-10.md); 6 is the default cap, `--jobs` overrides it.
 const jobs=requestedSerial?1:positive(option(args,'jobs','TEST_JOBS',undefined),'--jobs',Math.max(1,Math.min(6,Math.ceil(availableParallelism()*1.5))));
 const timeoutMs=positive(option(args,'timeout-ms','TEST_TIMEOUT_MS',undefined),'--timeout-ms',300000);
 const shard=parseShard(option(args,'shard','TEST_SHARD',undefined));
 if(shard===undefined){console.error(`--shard must be "index/count" with 1 <= index <= count, got "${option(args,'shard','TEST_SHARD',undefined)}"`);process.exit(2);}
 const suite=option(args,'suite','TEST_SUITE','core');
 if(suite!=='core'&&suite!=='non-functional'&&suite!=='all'){console.error(`--suite must be core, non-functional or all, got "${suite}"`);process.exit(2);}
 prepareSqlite();
 if(suite==='all'){
  if(shard){console.error('--suite all cannot be combined with --shard');process.exit(2);}
  const rest=[];
  for(let index=0;index<args.length;index++){if(args[index]==='--suite'){index++;continue;}rest.push(args[index]);}
  // The stages run asynchronously, so a SIGINT/SIGTERM sent to this wrapper is forwarded to the active stage, which stops its files, removes its own root and exits
  // 130/143. The wrapper waits for that exit (a bounded KILL_GRACE_MS plus a second grace, then SIGKILL of the stage) and never starts the next stage.
  let stage=null,wrapperInterrupted=null;
  const exitFor=signal=>signal==='SIGINT'?130:143;
  const runStage=name=>new Promise(resolve=>{
   const child=spawn(process.execPath,[path.resolve(new URL(import.meta.url).pathname),...rest,'--suite',name],{stdio:'inherit',env:{...process.env,TEST_SUITE:name,IPTV_TEST_SUITE:name}});
   stage=child;
   child.on('error',()=>{stage=null;resolve(1);});
   child.on('close',(code,signal)=>{stage=null;resolve(code??(signal?128+({SIGINT:2,SIGTERM:15,SIGKILL:9}[signal]??1):1));});
  });
  const forward=signal=>{
   wrapperInterrupted=wrapperInterrupted??signal;
   const active=stage;
   if(!active)return;
   try{active.kill(signal);}catch{}
   setTimeout(()=>{if(stage===active){try{active.kill('SIGKILL');}catch{}}},2*KILL_GRACE_MS+1000).unref();
  };
  process.on('SIGINT',()=>forward('SIGINT'));
  process.on('SIGTERM',()=>forward('SIGTERM'));
  // AIR-668: a full pass of the repository's own suite on an unchanged working tree is recorded (scripts/test-pass-record.mjs), so the pre-push hook can
  // skip running the same suite again on the same content. A synthetic --dir run, or IPTV_TEST_PASS_RECORD=0, records nothing.
  const recordable=process.env.IPTV_TEST_PASS_RECORD!=='0'&&path.resolve(directory)===path.resolve('tests');
  const testedTree=recordable?contentTree():null;
  const first=await runStage('core');
  if(wrapperInterrupted){console.error(`Interrupted by ${wrapperInterrupted}.`);process.exitCode=exitFor(wrapperInterrupted);return;}
  if(first!==0){process.exitCode=first;return;}
  const second=await runStage('non-functional');
  process.exitCode=wrapperInterrupted?exitFor(wrapperInterrupted):second;
  if(process.exitCode===0&&testedTree){
   const endTree=contentTree();
   if(endTree===testedTree){
    try{if(appendRecord(recordPath(),{tree:testedTree}))console.log(`Recorded the pass of tree ${testedTree.slice(0,12)} for the pre-push hook.`);}
    catch(error){console.error(`Could not record the pass for the pre-push hook: ${error.message}`);}
   }else console.log('The working tree changed during the run; the pass is not recorded for the pre-push hook.');
  }
  return;
 }
 let plan;
 try{plan=planTests({directory,serialOnly:serialOnly.size?serialOnly:SERIAL_ONLY,shard,suite,isolateMeasurements:args.includes('--isolate-measurements')||process.env.TEST_ISOLATE_MEASUREMENTS==='1'});}
 catch(error){if(error.code==='unclassified'){console.error(error.message);process.exit(2);}throw error;}
 const part=shard?` (shard ${shard.index}/${shard.count} of ${plan.suite} files)`:'';
 // One at a time is the previous behaviour: plain name order, and serial-only files are not moved to the end.
 if(jobs===1){plan.parallel=[...plan.parallel,...plan.serial].sort();plan.serial=[];}
 const keepTmp=process.env.IPTV_TEST_KEEP_TMP==='1';
 const run=createRunRoot();
 let cleanup=null;
 // Idempotent and synchronous, so it also runs from the exit hook (process.exit paths) and the signal fallback.
 const cleanUp=()=>{
  if(cleanup)return cleanup;
  cleanup=keepTmp?{removed:false,kept:true}:removeRunRoot(run);
  if(cleanup.error)console.error(`Test runner cleanup: could not remove ${run.root}: ${cleanup.error}`);
  return cleanup;
 };
 process.on('exit',cleanUp);
 const childEnv={...process.env,TMPDIR:run.root,TMP:run.root,TEMP:run.root,IPTV_TEST_RUN_ROOT:run.root,IPTV_TEST_SUITE:suite};
 const running=new Set(),results=[],failures=[];
 let stopping=false,interrupted=null;
 const started=Date.now();

 function runFile(file){
  return new Promise(resolve=>{
   const began=Date.now();
   const child=spawn(process.execPath,[path.join(directory,file)],{stdio:['ignore','pipe','pipe'],detached:true,env:childEnv});
   const record={file,stdout:'',stderr:'',omitted:0};
   const captures={stdout:capture(),stderr:capture()};
   let timedOut=false,settled=false,killTimer=null;
   child.stdout.setEncoding('utf8');
   child.stderr.setEncoding('utf8');
   child.stdout.on('data',chunk=>captures.stdout.push(chunk));
   child.stderr.on('data',chunk=>captures.stderr.push(chunk));
   const killGroup=signal=>{try{process.kill(-child.pid,signal);}catch{try{child.kill(signal);}catch{}}};
   const timer=setTimeout(()=>{timedOut=true;killGroup('SIGTERM');killTimer=setTimeout(()=>killGroup('SIGKILL'),KILL_GRACE_MS);},timeoutMs);
   const entry={child,pid:child.pid,kill:killGroup};
   running.add(entry);
   const finish=(code,signal,error)=>{
    if(settled)return;
    settled=true;
    clearTimeout(timer);if(killTimer)clearTimeout(killTimer);
    running.delete(entry);
    // Nothing the file left in its process group survives it.
    try{process.kill(-child.pid,'SIGKILL');}catch{}
    const ms=Date.now()-began;
    const ok=!timedOut&&!error&&code===0&&!signal;
    Object.assign(record,{stdout:captures.stdout.text(),stderr:captures.stderr.text(),omitted:captures.stdout.omitted()+captures.stderr.omitted(),ms,code,signal,timedOut,error:error?String(error.message||error):null,ok});
    resolve(record);
   };
   child.on('error',error=>finish(null,null,error));
   child.on('close',(code,signal)=>finish(code,signal,null));
  });
 }

 function report(record){
  results.push(record);
  if(record.ok){
   process.stdout.write(`ok   ${record.file} (${seconds(record.ms)})\n`);
   if(record.stdout)process.stdout.write(record.stdout.endsWith('\n')?record.stdout:record.stdout+'\n');
   if(record.stderr)process.stderr.write(record.stderr.endsWith('\n')?record.stderr:record.stderr+'\n');
   return;
  }
  failures.push(record);
  const why=record.timedOut?`timed out after ${timeoutMs}ms`:record.error?`could not start: ${record.error}`:record.signal?`killed by signal ${record.signal}`:`exit code ${record.code}`;
  process.stderr.write(`\nFAIL ${record.file} (${seconds(record.ms)}): ${why}\n`);
  if(record.stdout)process.stderr.write('--- stdout ---\n'+(record.stdout.endsWith('\n')?record.stdout:record.stdout+'\n'));
  if(record.stderr)process.stderr.write('--- stderr ---\n'+(record.stderr.endsWith('\n')?record.stderr:record.stderr+'\n'));
  if(record.omitted)process.stderr.write(`(${record.omitted} characters from the middle of the output of ${record.file} were omitted; the beginning and the end are shown)\n`);
  process.stderr.write(`--- end ${record.file} ---\n\n`);
 }

 async function pool(files,limit){
  const queue=[...files];
  const workers=Array.from({length:Math.min(limit,queue.length)},async()=>{
   while(queue.length&&!stopping){
    const file=queue.shift();
    const record=await runFile(file);
    report(record);
    if(!record.ok)stopping=true;
   }
  });
  await Promise.all(workers);
  return queue;
 }

 const onSignal=signal=>{
  interrupted=signal;stopping=true;
  for(const entry of running)entry.kill('SIGTERM');
  // Forced termination: SIGKILL the owned groups, then delete the root only once every owned group is confirmed gone (bounded wait). A group that is still there
  // keeps the root, which is logged, because a live writer could still be using it.
  setTimeout(async()=>{
   const owned=[...running];
   for(const entry of owned)entry.kill('SIGKILL');
   const gone=await groupsGone(owned.map(entry=>entry.pid),FORCE_WAIT_MS);
   if(!gone){cleanup={removed:false,error:`kept ${run.root}: an owned test process is still running after SIGKILL`};console.error(`Test runner cleanup: ${cleanup.error}`);}
   cleanUp();
   process.exit(signal==='SIGINT'?130:143);
  },KILL_GRACE_MS).unref();
 };
 process.on('SIGINT',()=>onSignal('SIGINT'));
 process.on('SIGTERM',()=>onSignal('SIGTERM'));

 console.log(`Running ${plan.total} self-contained test files, suite ${suite}${part} (${jobs===1?'serial':`up to ${jobs} at a time`}${plan.serial.length?`, ${plan.serial.length} serial-only`:''}, ${seconds(timeoutMs)} per file).`);
 const notStarted=[...await pool(plan.parallel,jobs)];
 if(!stopping)notStarted.push(...await pool(plan.serial,1));else notStarted.push(...plan.serial);
 const wall=Date.now()-started;
 // Last step of the run: every child is finished and its group killed. The report below is built from what is already in memory.
 const cleaned=cleanUp();
 const cleanupLine=cleaned.kept?`Temporary root kept (IPTV_TEST_KEEP_TMP=1): ${run.root}`:cleaned.removed?`Temporary root removed: ${cleaned.files} files, ${cleaned.bytes} bytes.`:`Temporary root NOT removed: ${run.root}`;

 const slowest=[...results].sort((a,b)=>b.ms-a.ms).slice(0,10);
 const busy=results.reduce((sum,record)=>sum+record.ms,0);
 process.stdout.write(`\nSlowest files: ${slowest.map(record=>`${record.file} ${seconds(record.ms)}`).join(', ')}\n`);
 process.stdout.write(`Wall ${seconds(wall)}, summed file time ${seconds(busy)}, ${results.length} of ${plan.total} files run${part}, suite ${suite}, jobs ${jobs}.\n${cleanupLine}\n`);
 if(process.env.IPTV_TEST_REPORT){
  const report={suite,shard:shard?`${shard.index}/${shard.count}`:null,wallMs:wall,summedFileMs:busy,jobs,failed:failures.map(record=>record.file),cleanup:{removed:Boolean(cleaned.removed),files:cleaned.files??null,bytes:cleaned.bytes??null,error:cleaned.error??null},files:results.map(record=>({file:record.file,ms:record.ms,ok:record.ok}))};
  try{writeFileSync(process.env.IPTV_TEST_REPORT,JSON.stringify(report,null,2));}
  catch(error){console.error(`could not write IPTV_TEST_REPORT: ${error.message}`);}
 }
 if(process.env.GITHUB_STEP_SUMMARY){
  const lines=[`### Test runner ${suite}${shard?` shard ${shard.index}/${shard.count}`:''}`,'',`${results.length} of ${plan.total} files run, jobs ${jobs}, wall ${seconds(wall)}, summed file time ${seconds(busy)}, ${failures.length} failed. ${cleanupLine}`,'','Wall time is a health metric. It does not gate merge or deploy. A failed file, a per-file timeout and the job timeout still fail this job.','','| Slowest files | Time | Result |','| --- | ---: | --- |',...slowest.map(record=>`| ${record.file} | ${seconds(record.ms)} | ${record.ok?'ok':'FAIL'} |`),''];
  try{appendFileSync(process.env.GITHUB_STEP_SUMMARY,lines.join('\n')+'\n');}catch{}
 }
 // Exit through exitCode, not process.exit(): when stdout or stderr is a pipe (as in CI) process.exit() can cut the report still being written.
 if(interrupted){console.error(`Interrupted by ${interrupted}.`);process.exitCode=interrupted==='SIGINT'?130:143;return;}
 if(failures.length){
  console.error(`FAILED ${failures.length} of ${plan.total} files: ${failures.map(record=>record.file).join(', ')}${notStarted.length?`; ${notStarted.length} not started after the first failure`:''}.`);
  process.exitCode=1;
  return;
 }
 console.log(`Passed ${results.length} self-contained test files${part}.`);
}

if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(new URL(import.meta.url).pathname))await main();
