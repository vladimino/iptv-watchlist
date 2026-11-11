// AIR-433 (ADR 0114): the film-level availability lifecycle, one pure function shared by the browser and the Worker.
//
// IPTV is used to pick a film from the ARCHIVE (catch-up), not to watch linear TV. So, per FILM and at an instant `now`:
//   available    some show has ENDED and is still inside the 72-hour catch-up window (a ready recording exists)
//   soon         no ready recording, but a show is on air now (its recording appears when it ends) or starts inside the next 24 hours
//   unavailable  neither
// A ready archive always wins over live and future: a later repeat never turns an available film into `soon`, and `soon` and `available` never both hold.
// A show that is on air is NOT an archive until it has ended. The moment a `soon` film turns `available` is the END of the show (for a future show too,
// not its start). An invalid or missing `end` is unknown and is never guessed: a show that has already started without a usable end is IGNORED (it is neither
// a ready recording nor a promised one), and a future show without one still makes the film `soon` but with no promised hour.
//
// The function reads only the shows it is given and nothing else: no storage, no network, no clock of its own, no time zone. The 24-hour and 72-hour
// windows are plain millisecond arithmetic, so a day of 23 or 25 hours (a DST change) and a call at 23:50 Madrid behave like any other instant.
// The caller decides which shows it has; the rolling +24 h window here is the same bound as the reader window and hot processing and does not widen
// them: a show later than that is not read as `soon`. The 168-hour retention of stored shows is not a product horizon and is not used here.
//
// Not the per-show `status` of the catalog DTO ('future' | 'on_air' | 'archive'): that legacy field says `archive` for a show without an `end`.
// `showPhase` below is the corrected per-show phase; the DTO field is unchanged (see the ADR).

export const AVAILABILITY_ARCHIVE_MS = 72 * 3600000;
export const AVAILABILITY_SOON_MS = 24 * 3600000;
export const AVAILABILITY_STATES = ['available', 'soon', 'unavailable'];
export const AVAILABILITY_LABELS = { available: 'Доступно', soon: 'Скоро', unavailable: 'Недоступно' };

const finite = value => {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const number = typeof value === 'number' ? value : typeof value === 'string' ? (/^\s*-?\d+(?:\.\d+)?\s*$/.test(value) ? Number(value) : Date.parse(value)) : NaN;
  return Number.isFinite(number) ? number : null;
};

// One show as numbers: `start` (null when it is not a time, and the show is then ignored), `end` (null when missing, invalid or not after the start).
export function normalizeShow(show) {
  const start = finite(show?.start);
  if (start === null) return null;
  const end = finite(show?.end);
  return { start, end: end !== null && end > start ? end : null };
}

// The phase of one show at `now`:
//   future   it starts later
//   on_air   it has started and its end is later
//   archive  it has ended and is inside the 72-hour window counted from its start
//   expired  it has ended and the window is over
//   unknown  it has started and has no usable end: nothing is promised for it
//   invalid  it has no usable start
export function showPhase(show, now, { archiveMs = AVAILABILITY_ARCHIVE_MS } = {}) {
  const item = normalizeShow(show);
  if (item === null || !Number.isFinite(now)) return { phase: 'invalid', start: null, end: null, endKnown: false };
  const { start, end } = item;
  if (start > now) return { phase: 'future', start, end, endKnown: end !== null };
  if (end === null) return { phase: 'unknown', start, end, endKnown: false };
  if (end > now) return { phase: 'on_air', start, end, endKnown: true };
  return start + archiveMs > now ? { phase: 'archive', start, end, endKnown: true } : { phase: 'expired', start, end, endKnown: true };
}

// The availability of one film. `shows` is a list of {start, end} (milliseconds or ISO strings); anything else is ignored.
// Returns:
//   state          'available' | 'soon' | 'unavailable'
//   label          the Russian user-facing word
//   appearsAt      soon only: the earliest known END among the shows that will become the archive (a show on air now, or one starting inside the next 24 h),
//                  as milliseconds; null when no such end is known. It is the SCHEDULED end from the programme guide, not proof that the provider has the
//                  recording ready at that instant: no probe is made and no recording delay is assumed (a product decision, not made here)
//   appearsAtKnown soon only: true when every candidate show has a known end (so the instant can be shown as exact); false means do not promise an hour
//   archiveUntil   available only: the last instant a ready recording is offered (the latest start of a ready show + 72 h), milliseconds
//   archiveShow    available only: the ready show that ends that window latest ({start, end})
//   onAir          a show is on air now (it does not make the film available)
//   nextStart      the first start later than `now` among the given shows (a repeat or the soon show), or null; additional information only
export function filmAvailability(shows, now, options = {}) {
  const archiveMs = options.archiveMs ?? AVAILABILITY_ARCHIVE_MS, soonMs = options.soonMs ?? AVAILABILITY_SOON_MS;
  const phases = [], list = Array.isArray(shows) ? shows : [];
  for (const show of list) {
    const phase = showPhase(show, now, { archiveMs });
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
    return { state: 'available', label: AVAILABILITY_LABELS.available, appearsAt: null, appearsAtKnown: null, archiveUntil: last.start + archiveMs, archiveShow: { start: last.start, end: last.end }, ...base };
  }
  const candidates = [...live, ...futures.filter(item => item.start < now + soonMs)];
  if (candidates.length) {
    const ends = candidates.map(item => item.end).filter(end => end !== null);
    return { state: 'soon', label: AVAILABILITY_LABELS.soon, appearsAt: ends.length ? Math.min(...ends) : null, appearsAtKnown: ends.length === candidates.length, archiveUntil: null, archiveShow: null, ...base };
  }
  return { state: 'unavailable', label: AVAILABILITY_LABELS.unavailable, appearsAt: null, appearsAtKnown: null, archiveUntil: null, archiveShow: null, ...base };
}
