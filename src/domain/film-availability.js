// AIR-433 (ADR 0114): the film-level availability lifecycle, one pure function shared by the browser and the Worker.
//
// IPTV is used to pick a film from the ARCHIVE (catch-up), not to watch linear TV. So, per FILM and at an instant `now`:
//   available    some show has ENDED and is still inside the 72-hour catch-up window (a ready recording exists)
//   soon         no ready recording, but a show is on air now (its recording appears when it ends) or starts inside the next 24 hours
//   unavailable  neither
// A ready archive always wins over live and future: a later repeat never turns an available film into `soon`, and `soon` and `available` never both hold.
// A show that is on air is NOT an archive until it has ended. The moment a `soon` film turns `available` is the EFFECTIVE END of the show (for a future show
// too, not its start), with no further delay and no provider probe. The effective end is the EPG `end` when it is valid; otherwise, when the film has a valid
// positive runtime, `start + runtime * 60 000 ms` (owner decision, AIR-433, ADR 0114: a minor divergence between runtime and broadcast duration is accepted, and
// no buffer or ad heuristic is added). With neither, the end is UNKNOWN and is never invented: a show that has already started without one is `unknown` (neither a
// ready recording nor a promised one) and is ignored, and a future show without one still makes the film `soon` but with no promised hour.
//
// The function reads only the shows it is given and nothing else: no storage, no network, no clock of its own, no time zone. The 24-hour and 72-hour
// windows are plain millisecond arithmetic, so a day of 23 or 25 hours (a DST change) and a call at 23:50 Madrid behave like any other instant.
// The caller decides which shows it has; the rolling +24 h window here is the same bound as the reader window and hot processing and does not widen
// them: a show later than that is not read as `soon`. The 168-hour retention of stored shows is not a product horizon and is not used here.
//
// `showPhase` below is the per-show phase; the catalog DTO's `shows[].status`, `availableNow` and `availableUntil` are derived from this module, so they
// cannot contradict `availability` (owner decision of 2026-11-11, see the ADR).

export const AVAILABILITY_ARCHIVE_MS = 72 * 3600000;
export const AVAILABILITY_SOON_MS = 24 * 3600000;
export const AVAILABILITY_STATES = ['available', 'soon', 'unavailable'];
export const AVAILABILITY_LABELS = { available: 'Доступно', soon: 'Скоро', unavailable: 'Недоступно' };

const finite = value => {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const number = typeof value === 'number' ? value : typeof value === 'string' ? (/^\s*-?\d+(?:\.\d+)?\s*$/.test(value) ? Number(value) : Date.parse(value)) : NaN;
  return Number.isFinite(number) ? number : null;
};

// The film runtime in minutes as milliseconds, or null when it is not a finite positive number (a numeric string is a number; zero, negative and text are not).
export function runtimeMs(runtimeMinutes) {
  const minutes = finite(runtimeMinutes);
  return minutes !== null && minutes > 0 ? minutes * 60000 : null;
}

// One show as numbers: `start` (null when it is not a time, and the show is then ignored); `end` is the effective end: the EPG end when it is after the start,
// else start + the runtime when there is one, else null; `endSource` says which ('epg' | 'runtime' | null).
export function normalizeShow(show, { runtimeMinutes = null } = {}) {
  const start = finite(show?.start);
  if (start === null) return null;
  const epg = finite(show?.end);
  if (epg !== null && epg > start) return { start, end: epg, endSource: 'epg' };
  const run = runtimeMs(runtimeMinutes);
  return run === null ? { start, end: null, endSource: null } : { start, end: start + run, endSource: 'runtime' };
}

// The phase of one show at `now`:
//   future   it starts later
//   on_air   it has started and its end is later
//   archive  it has ended and is inside the 72-hour window counted from its start
//   expired  it has ended and the window is over
//   unknown  it has started and no valid end can be determined (no valid EPG end and no usable runtime): nothing is promised for it
//   invalid  it has no usable start
// `end` is the effective end (see normalizeShow); the end instant itself already belongs to the archive (`end > now` is on air, `end <= now` is ready).
export function showPhase(show, now, { archiveMs = AVAILABILITY_ARCHIVE_MS, runtimeMinutes = null } = {}) {
  const item = normalizeShow(show, { runtimeMinutes });
  if (item === null || !Number.isFinite(now)) return { phase: 'invalid', start: null, end: null, endKnown: false, endSource: null };
  const { start, end, endSource } = item;
  if (start > now) return { phase: 'future', start, end, endKnown: end !== null, endSource };
  if (end === null) return { phase: 'unknown', start, end, endKnown: false, endSource };
  if (end > now) return { phase: 'on_air', start, end, endKnown: true, endSource };
  return start + archiveMs > now ? { phase: 'archive', start, end, endKnown: true, endSource } : { phase: 'expired', start, end, endKnown: true, endSource };
}

// The availability of one film. `shows` is a list of {start, end} (milliseconds or ISO strings); anything else is ignored. `options.runtimeMinutes` is the
// film runtime: the fallback for a show whose EPG end is missing or invalid.
// Returns:
//   state          'available' | 'soon' | 'unavailable'
//   label          the Russian user-facing word
//   appearsAt      soon only: the earliest effective END among the shows that will become the archive (a show on air now, or one starting inside the next
//                  24 h), as milliseconds; null when no such end is known. It is the SCHEDULED or ESTIMATED end (the EPG end, or start + runtime), not
//                  proof that the provider has the recording ready at that instant: no probe is made and no delay is added
//   appearsAtKnown soon only: true when every candidate show has an effective end; false means do not promise an hour
//   appearsAtEstimated soon only: true when the earliest end was derived from the film runtime, not read from the EPG
//   archiveUntil   available only: the last instant a ready recording is offered (the latest start of a ready show + 72 h), milliseconds
//   archiveShow    available only: the ready show that ends that window latest ({start, end})
//   onAir          a show is on air now (it does not make the film available)
//   nextStart      the first start later than `now` among the given shows (a repeat or the soon show), or null; additional information only
export function filmAvailability(shows, now, options = {}) {
  const archiveMs = options.archiveMs ?? AVAILABILITY_ARCHIVE_MS, soonMs = options.soonMs ?? AVAILABILITY_SOON_MS, runtimeMinutes = options.runtimeMinutes ?? null;
  const phases = [], list = Array.isArray(shows) ? shows : [];
  for (const show of list) {
    const phase = showPhase(show, now, { archiveMs, runtimeMinutes });
    if (phase.phase !== 'invalid') phases.push(phase);
  }
  const base = { onAir: false, nextStart: null };
  const futures = phases.filter(item => item.phase === 'future').sort((a, b) => a.start - b.start);
  base.nextStart = futures.length ? futures[0].start : null;
  const live = phases.filter(item => item.phase === 'on_air');
  base.onAir = live.length > 0;
  const ready = phases.filter(item => item.phase === 'archive');
  if (ready.length) {
    const last = ready.reduce((best, item) => (item.start > best.start ? item : best), ready[0]);
    return { state: 'available', label: AVAILABILITY_LABELS.available, appearsAt: null, appearsAtKnown: null, appearsAtEstimated: null, archiveUntil: last.start + archiveMs, archiveShow: { start: last.start, end: last.end }, ...base };
  }
  const candidates = [...live, ...futures.filter(item => item.start < now + soonMs)];
  if (candidates.length) {
    const known = candidates.filter(item => item.end !== null), appearsAt = known.length ? Math.min(...known.map(item => item.end)) : null;
    const estimated = appearsAt !== null && known.some(item => item.end === appearsAt && item.endSource === 'epg') === false;
    return { state: 'soon', label: AVAILABILITY_LABELS.soon, appearsAt, appearsAtKnown: known.length === candidates.length, appearsAtEstimated: appearsAt === null ? null : estimated, archiveUntil: null, archiveShow: null, ...base };
  }
  return { state: 'unavailable', label: AVAILABILITY_LABELS.unavailable, appearsAt: null, appearsAtKnown: null, appearsAtEstimated: null, archiveUntil: null, archiveShow: null, ...base };
}
