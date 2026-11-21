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
const countsOf = run => ({diaryPages: run?.checkpoint?.diaryPagesRead ?? 0, removalChecked: run?.checkpoint?.removalChecked ?? 0});

// `phase` is 'diary' (stop when the Diary part is done) or 'removal' (run to the end of the run).
export function ratingsSlotPhase({ratings, fenceGuard, phase}) {
  if (!ratings || typeof fenceGuard !== 'function' || !['diary', 'removal'].includes(phase)) return null;
  return {
    async run(ctx) {
      const at = () => new Date(ctx.now()).toISOString();
      const now = ctx.now();
      const env = {...ctx.env, ratingsFence: {guard: fenceGuard(ctx.epoch), hard: true}};
      let run = await ratings.readRun(env);
      const own = run && run.slotKey === ctx.slotKey ? run : null;
      if (phase === 'removal' && !own) return {done: true, outcome: 'skipped', at: at(), reason: 'no_slot_run'};
      if (own?.state === 'finished') return {done: true, outcome: phase === 'diary' ? 'finished' : 'done', at: at(), counts: countsOf(own)};
      if (own?.state === 'error' || own?.state === 'unknown') {
        const failed = outcomeOfError(own, now);
        return {done: true, ...failed, outcome: phase === 'removal' ? (failed.outcome === 'blocked' || failed.outcome === 'rate_limited' ? 'deferred' : 'error') : failed.outcome, at: at(), counts: countsOf(own)};
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
      if (['lease_lost', 'unknown', 'run_mismatch', 'not_running', 'storage_unsupported'].includes(reply.reason)) return {done: true, outcome: 'error', at: at(), reason: String(reply.reason).slice(0, 60)};
      return {done: false, wakeAt: now + SLEEP_FLOOR_MS};
    }
  };
}
