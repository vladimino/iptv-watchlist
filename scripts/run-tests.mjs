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
// AIR-374: approximate cost of the heaviest files, in seconds of CI file time at 921 summed seconds per shard: the mean over nine shard jobs (runs 43179499163, 43180054837, 43185880919, 43186573244 and 43188491322 of 12 Nov 2026, docs/evidence/ci/test-suite-air-374-ci-rebalance-p6-2026-11-12.md) of each file's share of its job's summed file time, so a fast or a slow runner does not skew a file.
// The two serial-only files are weighted by their time alone (about 7 s and 9 s, times the 5.8 file seconds one wall second holds when six files run at once), because they run after the parallel phase and add their whole duration to a shard's wall time.
// Two uses, both scheduling only: the files start heaviest first, and the files are dealt to the shards by greedy longest-processing-time assignment (every file has DEFAULT_WEIGHT unless listed), so
// the shards carry about the same total weight and not the same number of files. A name that no longer exists, or a new slow file that is missing here, changes the wall time and nothing else:
// every file still runs exactly once, in exactly one shard.
export const WEIGHTS={
 'generation-stage.mjs':104,
 'epg-r2-known-length.mjs':92,
 'film-person-connector-mutation.mjs':92,
 'generation-stage-withheld.mjs':79,
 'discovery-decisions-read.mjs':70,
 'film-person-prepared-loader-mutation.mjs':66,
 'projector-bulk.mjs':58,
 'film-person-capture-mutation.mjs':57,
 'film-person-cutover-record-mutation.mjs':57,
 'projector-view-parity.mjs':54,
 'sqlite-session-semantics.mjs':50,
 'discovery-bounded-drain.mjs':49,
 'discovery-chunk-budget.mjs':47,
 'local-dev-smoke.mjs':40,
 'discovery-seal-publish.mjs':38,
 'projector-marker-fence-mutation.mjs':38,
 'projector-bulk-spike.mjs':36,
 'run-tests-runner.mjs':31,
 'epg-diagnostic-context.mjs':8,
 'epg-replay-dataset.mjs':4,
 'epg-diagnostic-run.mjs':12,
 'epg-diagnostic-provision.mjs':15,
 'd1-enrichment-buckets.mjs':28,
 'canonical-differential-mutation.mjs':26,
 'd1-enrichment-stored-pages.mjs':26,
 'prediction-batch-start.mjs':25,
 'prediction-batch-submit.mjs':28,
 'scheduled-task-prompt-v2.mjs':20,
 'canonical-receipts-mutation.mjs':24,
 'd1-enrichment-bucket-unicode.mjs':24,
 'd1-backfill.mjs':22,
 'prediction-queue-budget.mjs':22,
 'canonical-catalog-titles-mutation.mjs':19,
 'discovery-production.mjs':19,
 'discovery-seal-throughput.mjs':19,
 'prediction-queue-cas.mjs':19,
 'film-person-prepared-loader.mjs':18,
 'offline-importer.mjs':18,
 'canonical-catalog-reader-mutation.mjs':17,
 'd1-enrichment-fairness.mjs':17,
 'd1-enrichment.mjs':16,
 'discovery-admission-packed.mjs':14,
 'prediction-authority-scope.mjs':14,
 'events-type-filter.mjs':13,
 'film-person-cutover-minimum-mutation.mjs':13,
 'migration-export.mjs':13,
 'get-write-audit.mjs':12,
 'discovery-archive-import.mjs':11,
 'film-person-capture.mjs':11,
 'film-person-baseline.mjs':9,
 'generation-stage-faults.mjs':9,
 'prediction-domain-production.mjs':8,
 'prediction-queue-discovery-independence.mjs':8,
 'r2-snapshot-export.mjs':8,
 'canonical-receipts.mjs':7,
 'discovery-authority.mjs':7,
 'discovery-operational-status.mjs':7,
 'epg-orchestration.mjs':7,
 'film-person-connector.mjs':7,
 'canonical-film-writers-mutation.mjs':6,
 'canonical-person-state-mutation.mjs':6,
 'canonical-producer-adapters-mutation.mjs':6,
 'canonical-epg-producer-mutation.mjs':6,
 'canonical-dictionary-producer-mutation.mjs':12,
 'discovery-pipeline-d1-status.mjs':6,
 'epg-status-ledger-mode.mjs':6,
 'prediction-overlay-index.mjs':6,
 'projector-marker-fence.mjs':6,
 'published-epg-production.mjs':6,
 'canonical-read-model.mjs':5,
 'deferred-completion-status.mjs':5,
 'discovery-bounded-d1-rehearsal.mjs':5,
 'discovery-status-memory.mjs':5,
 'metadata-cache.mjs':5,
 'projector-l1-budget.mjs':5,
 'admin-letterboxd-archive-api.mjs':4,
 'discovery-chunk-memory.mjs':4,
 'discovery-ledger-install.mjs':4,
 'discovery-seal-resume.mjs':4,
 'film-person-authority.mjs':4,
 'owner-review-d1.mjs':4,
 'projector-window.mjs':4,
};
export const DEFAULT_WEIGHT=0.8;
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
export function planTests({directory='tests',fixtureDependent=FIXTURE_DEPENDENT,serialOnly=SERIAL_ONLY,shard=null,weights=WEIGHTS}={}){
 const all=readdirSync(directory).filter(file=>file.endsWith('.mjs')&&!fixtureDependent.has(file)).sort();
 const weight=file=>weights[file]??DEFAULT_WEIGHT;
 const ordered=[...all].sort((a,b)=>weight(b)-weight(a)||(a<b?-1:1));
 const owner=new Map();
 if(shard){
  const load=Array(shard.count).fill(0);
  // A serial-only file adds its whole solo time after the parallel phase, so two of them never share a shard (while there is a free shard): the least loaded shard that holds no serial-only file yet. That keeps the rule true whatever a later WEIGHTS entry does to the rest of the deal.
  const serialHolders=new Set();
  const deal=file=>{
   const serial=serialOnly.has(file)&&serialHolders.size<load.length;
   let best=-1;
   for(let i=0;i<load.length;i++)if(!(serial&&serialHolders.has(i))&&(best<0||load[i]<load[best]))best=i;
   owner.set(file,best);load[best]+=weight(file);
   if(serialOnly.has(file))serialHolders.add(best);
  };
  // The mutation files (every one re-runs a production module against many mutants, spawning child processes) are CPU-bound and starve each other: on the 4 vCPU runner their per-file time grew five to ten times when several of them ran in one shard (CI runs 43179499163 and 43180054837: 205 s against 103 s for the same estimated weight). They are dealt first, as a class of their own, so every shard carries about the same share of them; the rest then fills up to the same total.
  for(const file of ordered)if(MUTATION.test(file))deal(file);
  for(const file of ordered)if(!MUTATION.test(file))deal(file);
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
