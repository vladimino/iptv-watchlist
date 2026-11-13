import {appendFileSync,readdirSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {availableParallelism} from 'node:os';
import path from 'node:path';

// AIR-378. Runs every self-contained test file in its own Node process (process isolation is kept), a bounded number at a time.
//
//   npm test                          default: min(6, ceil(1.5 x CPUs)) files at a time (AIR-408: the suite waits more than it computes)
//   npm test -- --serial              one file at a time, in name order (the previous behaviour)
//   npm test -- --jobs 2              at most 2 files at a time (also TEST_JOBS=2)
//   npm test -- --timeout-ms 120000   per-file limit (also TEST_TIMEOUT_MS), default 300000
//   npm test -- --shard 1/3           this part of the suite only (also TEST_SHARD); CI runs the three shards as three jobs (AIR-418)
//
// A failing, timed-out or signalled file is never lost: it is named with its exit code or signal and its full stdout and stderr, the runner
// stops starting new files, lets the running ones finish and exits non-zero. Files in SERIAL_ONLY run alone, after the parallel phase.

// Historical integration fixtures contain downloaded production snapshots and
// are intentionally not part of the public repository.
const FIXTURE_DEPENDENT=new Set([
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
// AIR-374 S4-2 (migration 0020): the four new entries (the two schema tests and the two preflight tests) are LOCAL estimates, not CI means: wall time of one `npm test -- --jobs 3` run on a shared machine (7.4 s, 36.8 s, 1.2 s and 9.2 s) scaled by the ratio of the entries of the existing files of the same kind; a CI recalibration replaces them.
export const WEIGHTS={
 'epg-r2-known-length.mjs':72,
 'generation-stage.mjs':71,
 'film-person-connector-mutation.mjs':42,
 'film-person-e6-measure-mutation.mjs':61,
 'discovery-decisions-read.mjs':48,
 'prediction-batch-start.mjs':28,
 'film-person-prepared-loader-mutation.mjs':49,
 'generation-stage-withheld.mjs':48,
 'prediction-batch-submit.mjs':24,
 'film-person-capture-mutation.mjs':45,
 'discovery-bounded-drain.mjs':34,
 'discovery-seal-publish.mjs':42,
 'film-person-cutover-record-mutation.mjs':42,
 'scheduled-task-prompt-v2.mjs':12,
 'sqlite-session-semantics.mjs':42,
 'canonical-epg-person-producer-mutation.mjs':16,
 'canonical-producer-schema-mutation.mjs':40,
 'film-person-0020-preflight-mutation.mjs':14,
 'projector-bulk.mjs':26,
 'canonical-dictionary-producer-mutation.mjs':14,
 'discovery-chunk-budget.mjs':14,
 'projector-view-parity.mjs':32,
 'canonical-receipted-writers-mutation.mjs':6,
 'local-dev-smoke.mjs':31,
 'run-tests-runner.mjs':31,
 'projector-marker-fence-mutation.mjs':10,
 'canonical-producer-adapters-mutation.mjs':11,
 'd1-enrichment-buckets.mjs':26,
 'projector-bulk-spike.mjs':24,
 'canonical-differential-mutation.mjs':22,
 'd1-enrichment-bucket-unicode.mjs':22,
 'd1-backfill.mjs':21,
 'prediction-queue-budget.mjs':21,
 'epg-diagnostic-run.mjs':20,
 'prediction-authority-scope.mjs':12,
 'd1-enrichment-stored-pages.mjs':19,
 'canonical-catalog-titles-mutation.mjs':18,
 'canonical-receipts-mutation.mjs':21,
 'canonical-epg-producer-mutation.mjs':11,
 'prediction-queue-cas.mjs':16,
 'd1-enrichment-fairness.mjs':15,
 'discovery-production.mjs':15,
 'discovery-seal-throughput.mjs':12,
 'offline-importer.mjs':14,
 'epg-diagnostic-context.mjs':9,
 'film-person-prepared-loader.mjs':13,
 'film-person-h1-rehearsal.mjs':12,
 'canonical-catalog-reader-mutation.mjs':12,
 'd1-enrichment.mjs':12,
 'film-person-capture.mjs':11,
 'get-write-audit.mjs':11,
 'film-person-0019-preflight-mutation.mjs':10,
 'discovery-archive-import.mjs':9,
 'epg-replay-dataset.mjs':9,
 'film-person-cutover-minimum-mutation.mjs':8,
 'migration-export.mjs':9,
 'canonical-receipted-writers.mjs':8,
 'epg-orchestration.mjs':8,
 'prediction-domain-production.mjs':8,
 'prediction-overlay-index.mjs':8,
 'canonical-person-state-mutation.mjs':7,
 'discovery-bounded-d1-rehearsal.mjs':7,
 'discovery-operational-status.mjs':7,
 'discovery-status-memory.mjs':7,
 'epg-status-ledger-mode.mjs':7,
 'prediction-queue-discovery-independence.mjs':7,
 'canonical-read-model.mjs':6,
 'canonical-receipts.mjs':6,
 'canonical-producer-schema.mjs':3,
 'discovery-admission-packed.mjs':7,
 'film-person-connector.mjs':6,
 'prediction-dry-run-isolation.mjs':6,
 'projector-l1-budget.mjs':6,
 'canonical-producer-run-mutation.mjs':25,
 'projector-marker-fence.mjs':6,
 'canonical-film-external-ids-producer-mutation.mjs':5,
 'canonical-discovery-admission-producer-mutation.mjs':5,
 'canonical-producer-store-mutation.mjs':3,
 'epg-producer-dry-run-mutation.mjs':3,
 'epg-producer-m2b-mutation.mjs':9,
 'epg-producer-m2b-reader-mutation.mjs':19,
 'canonical-person-mutation-producer-mutation.mjs':9,
 'canonical-epg-person-producer.mjs':5,
 'canonical-film-writers-mutation.mjs':5,
 'discovery-authority.mjs':5,
 'discovery-ledger-install.mjs':5,
 'discovery-pipeline-d1-status.mjs':5,
 'film-person-authority.mjs':5,
 'film-person-baseline.mjs':5,
 'generation-stage-faults.mjs':5,
 'projector-window.mjs':5,
 'published-epg-production.mjs':5,
 'r2-snapshot-export.mjs':5,
 'admin-letterboxd-archive-api.mjs':4,
 'canonical-dictionary-producer.mjs':4,
 'canonical-producers.mjs':4,
 'deferred-completion-status.mjs':4,
 'discovery-seal-resume.mjs':4,
 'epg-diagnostic-provision.mjs':4,
 'film-person-cutover-run.mjs':4,
 'film-person-e6-measure.mjs':4,
 'metadata-cache.mjs':4,
 'canonical-catalog-reader.mjs':3,
 'canonical-catalog-titles.mjs':3,
 'canonical-differential.mjs':3,
 'canonical-epg-producer.mjs':3,
 'd1-enrichment-phases.mjs':3,
 'discovery-bounded-fence.mjs':3,
 'discovery-chunk-memory.mjs':3,
 'discovery-ledger-split.mjs':3,
 'film-admission.mjs':3,
 'owner-review-d1.mjs':3,
 'prediction-domain.mjs':3,
 'published-epg.mjs':3,
 'admin-letterboxd-apply.mjs':2,
 'admin-shell.mjs':2,
 'canonical-film-writers.mjs':2,
 'canonical-handoff-readiness.mjs':2,
 'canonical-person-state.mjs':2,
 'canonical-producer-adapters.mjs':2,
 'catalog-watched-d1.mjs':2,
 'cron-schedule-simulation.mjs':2,
 'd1-enrichment-duplicate-retained.mjs':2,
 'd1-projection-seed.mjs':2,
 'discovery-events.mjs':2,
 'discovery-ledger-archive.mjs':2,
 'discovery-seal-reads.mjs':2,
 'epg-commit-durable-enqueue.mjs':2,
 'epg-mirror-reconciliation.mjs':2,
 'film-person-0019-preflight.mjs':2,
 'film-person-0020-preflight.mjs':2,
 'film-person-cutover-accepted.mjs':2,
 'film-sync-state.mjs':2,
 'item-failures.mjs':2,
 'letterboxd-baseline-chunks.mjs':2,
 'letterboxd-rated-candidates.mjs':2,
 'lifecycle-diagnostics.mjs':2,
 'localization-sources.mjs':2,
 'metadata-cache-production.mjs':2,
 'prediction-batch-profile.mjs':2,
 'ratings-cursor-merge.mjs':2,
 'ratings-orchestration.mjs':2,
 'ratings-run.mjs':2,
 'tmdb-retirement-decisions.mjs':2,
 'tmdb-tv-runtime.mjs':2,
};
export const DEFAULT_WEIGHT=0.5;
// Weight the first shard is dealt less than the others: its job (`Test and build`) also runs the documentation governance check, the build, the Discovery Workflow bundle validation and the artifact upload outside `Run tests`, about 9 s more of job wall time than a plain shard job (about 5% of a shard's roughly 195 s); 33 units are 7 s of wall at 0.233 s a unit. It is a starting load in the deal, so shard 1 ends about this much lighter than shards 2 and 3.
export const FIRST_SHARD_OFFSET=33;
// AIR-374 contention cohort (see planTests): the files that compete for the CPU are the mutation files (any weight) and every other file of at least HEAVY_MIN_WEIGHT units, about 9% of the files and 55% of the weight. They are dealt before the rest by "pressure": a file's weight, times HEAVY_MUTATION_PRESSURE for a mutation file, which re-runs a production module against many mutants in child processes and so takes far more of a 4 vCPU runner than its weight says (a fit of the 36 shard jobs of 12 runs gives about 0.65 s of `Run tests` per mutation unit against 0.06 to 0.09 s per unit of any other weight). Shard 1 starts FIRST_SHARD_HEAVY_CREDIT pressure units ahead: with 117 s in the last run against 158 s and 187 s it has the most headroom, so it gets the largest cohort share; its total weight is still dealt less by FIRST_SHARD_OFFSET.
export const HEAVY_MIN_WEIGHT=20;
export const HEAVY_MUTATION_PRESSURE=6;
export const FIRST_SHARD_HEAVY_CREDIT=60;
const MUTATION=/-mutation\.mjs$/;
// Output of one stream is kept whole up to HEAD_LIMIT+TAIL_LIMIT characters. Beyond that the beginning and the END are kept and the middle is
// dropped with an explicit notice: the last lines of a failing file (its assertion and stack) are the ones that matter.
export const HEAD_LIMIT=1024*1024;
export const TAIL_LIMIT=3*1024*1024;
const KILL_GRACE_MS=3000;

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
export function planTests({directory='tests',fixtureDependent=FIXTURE_DEPENDENT,serialOnly=SERIAL_ONLY,shard=null,weights=WEIGHTS,firstShardOffset=FIRST_SHARD_OFFSET,heavyMinWeight=HEAVY_MIN_WEIGHT,heavyCredit=FIRST_SHARD_HEAVY_CREDIT,mutationPressure=HEAVY_MUTATION_PRESSURE}={}){
 const all=readdirSync(directory).filter(file=>file.endsWith('.mjs')&&!fixtureDependent.has(file)).sort();
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
 const plan=planTests({directory,serialOnly:serialOnly.size?serialOnly:SERIAL_ONLY,shard});
 const part=shard?` (shard ${shard.index}/${shard.count} of ${plan.suite} files)`:'';
 // One at a time is the previous behaviour: plain name order, and serial-only files are not moved to the end.
 if(jobs===1){plan.parallel=[...plan.parallel,...plan.serial].sort();plan.serial=[];}
 const running=new Set(),results=[],failures=[];
 let stopping=false,interrupted=null;
 const started=Date.now();

 function runFile(file){
  return new Promise(resolve=>{
   const began=Date.now();
   const child=spawn(process.execPath,[path.join(directory,file)],{stdio:['ignore','pipe','pipe'],detached:true});
   const record={file,stdout:'',stderr:'',omitted:0};
   const captures={stdout:capture(),stderr:capture()};
   let timedOut=false,settled=false,killTimer=null;
   child.stdout.setEncoding('utf8');
   child.stderr.setEncoding('utf8');
   child.stdout.on('data',chunk=>captures.stdout.push(chunk));
   child.stderr.on('data',chunk=>captures.stderr.push(chunk));
   const killGroup=signal=>{try{process.kill(-child.pid,signal);}catch{try{child.kill(signal);}catch{}}};
   const timer=setTimeout(()=>{timedOut=true;killGroup('SIGTERM');killTimer=setTimeout(()=>killGroup('SIGKILL'),KILL_GRACE_MS);},timeoutMs);
   const entry={child,kill:killGroup};
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
  setTimeout(()=>{for(const entry of running)entry.kill('SIGKILL');process.exit(signal==='SIGINT'?130:143);},KILL_GRACE_MS).unref();
 };
 process.on('SIGINT',()=>onSignal('SIGINT'));
 process.on('SIGTERM',()=>onSignal('SIGTERM'));

 console.log(`Running ${plan.total} self-contained test files${part} (${jobs===1?'serial':`up to ${jobs} at a time`}${plan.serial.length?`, ${plan.serial.length} serial-only`:''}, ${seconds(timeoutMs)} per file).`);
 const notStarted=[...await pool(plan.parallel,jobs)];
 if(!stopping)notStarted.push(...await pool(plan.serial,1));else notStarted.push(...plan.serial);
 const wall=Date.now()-started;

 const slowest=[...results].sort((a,b)=>b.ms-a.ms).slice(0,10);
 const busy=results.reduce((sum,record)=>sum+record.ms,0);
 process.stdout.write(`\nSlowest files: ${slowest.map(record=>`${record.file} ${seconds(record.ms)}`).join(', ')}\n`);
 process.stdout.write(`Wall ${seconds(wall)}, summed file time ${seconds(busy)}, ${results.length} of ${plan.total} files run${part}, jobs ${jobs}.\n`);
 if(process.env.GITHUB_STEP_SUMMARY){
  const lines=[`### Test runner${shard?` shard ${shard.index}/${shard.count}`:''}`,'',`${results.length} of ${plan.total} files run, jobs ${jobs}, wall ${seconds(wall)}, summed file time ${seconds(busy)}, ${failures.length} failed.`,'','| Slowest files | Time | Result |','| --- | ---: | --- |',...slowest.map(record=>`| ${record.file} | ${seconds(record.ms)} | ${record.ok?'ok':'FAIL'} |`),''];
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
