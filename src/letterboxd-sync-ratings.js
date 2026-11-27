// AIR-570 / ADR 0186 decisions 3 and 4. The Diary-and-Ratings phase and the removal-reconciliation phase of a Letterboxd Sync slot, as ports over the existing ratings pipeline (`LetterboxdRatings`
// start and step). The pipeline's run has two phases, `diary` then `removal`: this module stops phase 1 when the Diary part is done and lets phase 3 finish the run, so the Watchlist scan sits between
// them. A run started here carries the slot key, which makes the pipeline write NO `ratings` Event of its own (the slot outbox is the only source). Every pipeline write rides in a batch with the
// Letterboxd mode-epoch guard (`env.ratingsFence.guard`), so a stale instance writes nothing. Outcomes are by class only; no message is stored.
const SLEEP_FLOOR_MS = 1000, BUSY_WAIT_MS = 60000;

function outcomeOfError(run, now) {
  if (run?.cause === 'blocked') return {outcome: 'blocked', reason: 'upstream_blocked'};
  if (run?.cause === 'rate_limited') {
    const paused = Date.parse(run.removal?.pausedUntil || '');
    return {outcome: 'rate_limited', reason: 'http_429', ...(Number.isFinite(paused) && paused > now ? {pausedUntil: paused} : {})};
  }
  return {outcome: 'error', reason: 'network_error'};
}
// Counts are those of THIS slot's own run only (never an inherited one); no run, no counts.
const countsOf = run => run ? ({diaryPages: run.checkpoint?.diaryPagesRead ?? 0, removalChecked: run.checkpoint?.removalChecked ?? 0}) : null;
// AIR-694: the pipeline's step replies that mean the run was INTERRUPTED (outcome unknown), as opposed to a confirmed error. The reason is the bounded reply code, the phase the run's own record shows.
const INTERRUPTED_REPLIES = ['lease_lost', 'unknown', 'run_mismatch', 'not_running'];
const phaseOf = (run, fallback) => ['diary', 'removal'].includes(run?.interruptedPhase) ? run.interruptedPhase : ['diary', 'removal'].includes(run?.phase) ? run.phase : fallback;
// What a phase reports for a run that is already `unknown` (closed as interrupted or abandoned): the Diary phase reports an interrupted Ratings outcome; the reconciliation phase stays operational (an `error` of the reconciliation,
// which never changes a finished Diary outcome) and carries the interruption beside it for the slot Event.
function interruptedOf(run, phase, reason) {
  const info = {reason: String(reason || run?.cause || 'interrupted').slice(0, 60), phase: phaseOf(run, phase)};
  return phase === 'removal' ? {outcome: 'error', interrupted: info, ...info} : {outcome: 'interrupted', ...info};
}
// The AIR-361 Event contract of a finished or failed run (state, cause, coverage, diary, removal, details), built by the pipeline itself so it cannot drift; null while the run is still going.
const eventOf = (ratings, run) => { try { return typeof ratings.ratingsEventOf === 'function' ? ratings.ratingsEventOf(run, {slotOwned: true}) : null; } catch { return null; } };

// `phase` is 'diary' (stop when the Diary part is done) or 'removal' (run to the end of the run).
export function ratingsSlotPhase({ratings, fenceGuard, phase}) {
  if (!ratings || typeof fenceGuard !== 'function' || !['diary', 'removal'].includes(phase)) return null;
  return {
    async run(ctx) {
      const at = () => new Date(ctx.now()).toISOString();
      const now = ctx.now();
      // Ratings documents assert the epoch in their own batch (`ratingsFence.guard`); canonical Film/Person writes the pipeline may make (the rated-only bridge) assert it through the `letterboxd` producer fence.
      const env = {...ctx.env, ratingsFence: {guard: fenceGuard(ctx.epoch), hard: true}, producerFence: {kind: 'letterboxd', epoch: ctx.epoch}};
      let run = await ratings.readRun(env);
      const own = run && run.slotKey === ctx.slotKey ? run : null;
      if (phase === 'removal' && !own) return {done: true, outcome: 'skipped', at: at(), reason: 'no_slot_run'};
      if (own?.state === 'finished') return {done: true, outcome: phase === 'diary' ? 'finished' : 'done', at: at(), counts: countsOf(own), event: eventOf(ratings, own)};
      if (own?.state === 'unknown') return {done: true, ...interruptedOf(own, phase), at: at(), counts: countsOf(own), event: eventOf(ratings, own)};
      if (own?.state === 'error') {
        const failed = outcomeOfError(own, now);
        return {done: true, ...failed, outcome: phase === 'removal' ? (failed.outcome === 'blocked' || failed.outcome === 'rate_limited' ? 'deferred' : 'error') : failed.outcome, at: at(), counts: countsOf(own), event: eventOf(ratings, own)};
      }
      // The Diary part is done once the run moved to its removal phase; phase 1 ends there and leaves the run for phase 3.
      if (own?.state === 'running' && own.phase === 'removal' && phase === 'diary') return {done: true, outcome: 'finished', at: at(), counts: countsOf(own)};
      // A run an EARLIER slot started and did not finish (its reconciliation was deferred) is still ours: it is stepped to its end first, by whichever phase finds it, before a new run starts.
      const inherited = !own && run?.state === 'running' && run.slotKey ? run : null;
      let runId = own?.state === 'running' ? own.runId : inherited ? inherited.runId : null;
      if (!runId) {
        if (phase === 'removal') return {done: true, outcome: 'skipped', at: at(), reason: 'no_running_run'};
        const reply = await ratings.start(env, {trigger: 'scheduled', slotKey: ctx.slotKey}, now);
        if (reply.reason === 'storage_unsupported') return {done: true, outcome: 'error', at: at(), reason: 'config_invalid'};
        if (reply.reason === 'isolated') return {done: true, outcome: 'error', at: at(), reason: 'evidence_contradictory'};
        if (reply.reason === 'busy') return {done: false, wakeAt: now + BUSY_WAIT_MS};
        if (!reply.created) return {done: true, outcome: 'error', at: at(), reason: 'owner_unknown'};
        return {done: false, wakeAt: now + SLEEP_FLOOR_MS};
      }
      const reply = await ratings.step(env, {runId}, {now, clock: ctx.clock || (() => Date.now())});
      if (reply.reason === 'busy') { const until = Date.parse(reply.nextCatchUpAt || ''); return {done: false, wakeAt: Number.isFinite(until) ? until : now + BUSY_WAIT_MS}; }
      // AIR-694: a lost lease or a run the pipeline no longer recognises is an INTERRUPTION of the run (outcome unknown), not a confirmed error; the phase and the stored checkpoint stay known facts.
      if (INTERRUPTED_REPLIES.includes(reply.reason)) {
        // The run is read again: what the step committed before it lost its lease is positively THIS slot's work (same run id, same slot key). The same builder as for a stored `unknown` run turns that record into the
        // Event contract in memory only: nothing is stored, no terminal state is invented and the run is not stepped again. A run that is not ours, or already terminal, gives no contract here.
        const latest = await ratings.readRun(env).catch(() => null);
        const mine = latest && latest.runId === runId && latest.slotKey === ctx.slotKey ? latest : null;
        const view = mine && mine.state === 'running' ? {...mine, state: 'unknown', cause: 'interrupted', interruptedPhase: phaseOf(mine, phase), closedAt: at()} : mine;
        const attributed = mine && ['running', 'unknown'].includes(mine.state) ? view : null;
        return {done: true, ...interruptedOf(attributed || own || inherited, phase, reply.reason), at: at(), counts: countsOf(own), ...(attributed ? {event: eventOf(ratings, attributed)} : {})};
      }
      if (reply.reason === 'storage_unsupported') return {done: true, outcome: 'error', at: at(), reason: 'storage_unsupported'};
      return {done: false, wakeAt: now + SLEEP_FLOOR_MS};
    }
  };
}
