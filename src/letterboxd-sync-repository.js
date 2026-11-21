// AIR-570 / ADR 0186. The adapter between the Letterboxd Sync Watchlist phase and the Watchlist authority repository (`WatchlistD1`, schema v31).
// It maps the phase's repository contract (src/letterboxd-sync-watchlist.js) onto the repository's functions and adds nothing to storage: no table, no SQL of its own.
// Every committing call carries the Workflow's mode-epoch guard, so a stale instance of a closed mode writes nothing (decision 3). The causal effects are applied by
// INJECTED writers (`effectWriters.scan_facts|retention|removal_enqueue`, each `(ctx, effect, snapshot) -> receipt string`); an effect with no writer holds the drain
// (`effect_writer_absent`) and the scan, it is never marked done without a receipt. The admission ledger step is injected too (`admitNew`), and is optional.
export function watchlistRepository(WatchlistD1, {epochGuard, effectWriters = {}, admitNew = null} = {}) {
  const guards = ctx => {
    if (typeof epochGuard !== 'function' || !Number.isInteger(ctx?.epoch)) return null;
    const guard = epochGuard(ctx.epoch);
    return Array.isArray(guard) ? [guard] : null;
  };
  return {
    // Ready only for an open `d1` authority AND a Workflow epoch guard: without either, the phase is disabled and nothing is fetched.
    async ready(ctx) {
      if (!WatchlistD1 || !guards(ctx)) return {ready: false};
      try { const state = await WatchlistD1.readAuthority(ctx.env); return {ready: state?.state === 'd1' && state.writes === 'open'}; } catch { return {ready: false}; }
    },
    // The pending causal effects, oldest version first, each applied by its writer and then marked done with the receipt. A failure is counted and holds the drain.
    async drainEffects(ctx, {now}) {
      const g = guards(ctx);
      if (!g) return {drained: false, code: 'epoch_guard_absent'};
      for (let pass = 0; pass < 8; pass++) {
        const pending = await WatchlistD1.pendingEffects(ctx.env);
        if (!pending.ok) return {drained: false, code: 'effects_unreadable'};
        const next = pending.effects[0];
        if (!next) return {drained: true};
        const writer = effectWriters[next.effect];
        if (typeof writer !== 'function') return {drained: false, code: 'effect_writer_absent'};
        let receipt;
        try { receipt = await writer(ctx, next); } catch { receipt = null; }
        if (typeof receipt !== 'string' || !receipt) {
          await WatchlistD1.recordEffectAttempt(ctx.env, next, {now, guards: g}).catch(() => null);
          return {drained: false, code: 'effect_failed'};
        }
        const done = await WatchlistD1.completeEffect(ctx.env, {snapshotId: next.snapshotId, effect: next.effect, receipt}, {now, guards: g});
        if (!done.ok) return {drained: false, code: done.reason === 'out_of_order' ? 'effect_out_of_order' : 'effect_unavailable'};
      }
      return {drained: false, code: 'effects_backlog'};
    },
    // One publication. `no_change` still advances `last_success_at` inside the repository. `indeterminate` is never replayed here.
    async commitScan(ctx, {members, scan}) {
      const g = guards(ctx);
      if (!g) throw Object.assign(new Error('epoch guard'), {code: 'epoch_guard_absent'});
      const result = await WatchlistD1.publishSnapshot(ctx.env, members, {...scan, completedAt: scan.observedAt}, {now: ctx.now(), guards: g});
      if (!result.ok) throw Object.assign(new Error(result.reason), {code: String(result.reason).slice(0, 60)});
      const current = await WatchlistD1.readCurrent(ctx.env, {now: ctx.now()});
      const snapshot = current.ok ? current.snapshot : null;
      return {outcome: result.outcome, version: result.version, lastSuccessAt: snapshot?.lastSuccessAt ?? null, total: members.length, baseline: result.version === 1 && (result.removed || []).length === 0 && result.outcome === 'committed' && (result.added || []).length === members.length,
        added: (result.added || []).map(lid => ({lid})), removed: (result.removed || []).map(lid => ({lid}))};
    },
    async recordAttempt(ctx, {outcome, at, code}) {
      const g = guards(ctx);
      if (!g) return;
      await WatchlistD1.recordAttempt(ctx.env, {at, outcome: String(outcome).slice(0, 60), now: ctx.now(), guards: g});
    },
    ...(typeof admitNew === 'function' ? {admitNew: (ctx, arg) => admitNew(ctx, arg)} : {})
  };
}
