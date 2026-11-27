// Durable rated-only candidates for one confirmed Letterboxd archive (AIR-340).
// The document is archive state in R2, beside the import receipt. It is not a ratings document and not a Film.
// Nothing here runs from the cron. Preview does not call it. A short code is never written as a Letterboxd lid.
const LetterboxdRatedCandidates = (() => {
  const CANDIDATES = sha => 'letterboxd/imports/' + sha + '/rated-candidates.json';
  const ADMISSIONS = 'letterboxd/admissions/verified-films.json';
  const HEX64 = /^[0-9a-f]{64}$/;
  const PAGE_MS = 25000, PAGE_BYTES = 3000000, DETAIL_MS = 12000, DETAIL_BYTES = 1000000;
  const emptyDoc = (sha, generatedAt) => ({schemaVersion: 1, archiveSha256: sha, generatedAt, candidates: {}, checkpoint: {cursor: null, stopped: null}});

  // `routed: false` reads the R2 object directly: a legacy compare-and-swap that already routed to R2 must never silently read a D1 document if the marker moved meanwhile (its fresh guard before the PUT refuses instead).
  async function readDoc(env, key, {routed = true} = {}) {
    try {
      // ADR 0222: at marker `d1` the candidate document is a D1 Ratings document: no R2 read, no fallback. Under `closed` R2 is quiescent and still the record; an unreadable marker throws and is reported as unavailable storage.
      if (routed && typeof LetterboxdAdmissionDocuments !== 'undefined') {
        const route = await LetterboxdAdmissionDocuments.readRoute(env, key);
        if (route.d1) return await LetterboxdAdmissionDocuments.readDocument(env, key);
      }
      const object = await env.BUCKET.get(key);
      if (!object) return {value: null, etag: null};
      return {value: await object.json(), etag: object.etag ?? null};
    } catch {return {value: undefined, etag: null};}
  }
  // AIR-527 (ADR 0170): after a candidate document write succeeded, the derived archive registry is updated with its own bounded
  // compare-and-swap. The registry is a projection and never an owner: a missing module, a refused or lost update and any storage
  // error are swallowed, the successful primary write stands, no second owner appears and no older archive is hidden. The next
  // writer of the archive repairs the row; a GET never writes it.
  async function syncRegistry(env, key, doc, etag) {
    if (typeof LetterboxdImportRegistry === 'undefined') return;
    const sha = LetterboxdImportRegistry.archiveOfCandidateKey(key);
    if (!sha) return;
    try {
      const now = new Date().toISOString();
      const summary = LetterboxdImportRegistry.summarizeDocument(doc, {etag, now});
      for (let attempt = 0; attempt < 3; attempt++) {
        const current = await readDoc(env, LetterboxdImportRegistry.REGISTRY_KEY);
        if (current.value === undefined) return;
        const result = LetterboxdImportRegistry.applyArchive(current.value, sha, summary, now);
        if (!result.changed) return;
        // PR #1018 review: the registry projection is a legacy R2 write too: a fresh marker read right before its PUT refuses it under `closed`, `d1` and an unreadable marker (it is swallowed: derived and droppable).
        if (typeof LetterboxdAdmissionAuthority !== 'undefined') await LetterboxdAdmissionAuthority.guardLegacyWrite(env);
        const saved = await env.BUCKET.put(LetterboxdImportRegistry.REGISTRY_KEY, JSON.stringify(result.registry), {httpMetadata: {contentType: 'application/json'}, onlyIf: current.etag ? {etagMatches: current.etag} : {etagDoesNotMatch: '*'}});
        if (saved !== null) return;
      }
    } catch {/* derived and droppable: the primary write already succeeded */}
  }
  async function casDoc(env, key, empty, apply, {extra = []} = {}) {
    // ADR 0222: at marker `d1` the write is one D1 batch (document compare-and-swap, the marker assertion and the caller's `extra`, e.g. the operation-history assertion of a terminal disposition); `refused` means
    // that assertion did not hold and nothing was written. The mutation revision rises inside that batch as at R2. The derived registry projection is not written (no live R2 projection after the cutover).
    if (typeof LetterboxdAdmissionDocuments !== 'undefined' && key !== ADMISSIONS) {
      const routed = await LetterboxdAdmissionDocuments.documentRoute(env, key);
      if (routed.d1) {
        return LetterboxdAdmissionDocuments.casDocument(env, key, empty, async (draft, etag) => {
          const next = await apply(draft);
          if (next == null) return null;
          if (typeof LetterboxdImportRegistry !== 'undefined' && LetterboxdImportRegistry.archiveOfCandidateKey(key)) next.revision = (Number.isInteger(draft?.revision) && draft.revision >= 0 ? draft.revision : 0) + 1;
          return next;
        }, {extra, authority: routed.authority});
      }
    }
    if (extra.length) throw new Error('atomic_unavailable');
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = await readDoc(env, key, {routed: false});
      if (current.value === undefined) throw new Error('storage_unavailable');
      const base = current.value || empty;
      const next = await apply(JSON.parse(JSON.stringify(base)));
      if (next == null) return {value: base, changed: false};
      // AIR-527: a candidate document carries a mutation revision. It rises by one inside the compare-and-swap that writes it, so two
      // committed writes are always ordered, whatever the order in which their responses arrive and their registry syncs start.
      if (typeof LetterboxdImportRegistry !== 'undefined' && LetterboxdImportRegistry.archiveOfCandidateKey(key)) next.revision = (Number.isInteger(base?.revision) && base.revision >= 0 ? base.revision : 0) + 1;
      // AIR-602 / ADR 0207 decision 1 and ADR 0222 decision 7: every R2 write of the admission coordination (the admissions object AND the candidate document) happens only while the marker, read FRESH here as the last awaited
      // step before the PUT, proves `r2` or proves the migration absent. A write routed to R2 earlier that is now past a close or a flip is refused, never switched to D1.
      if (typeof LetterboxdAdmissionAuthority !== 'undefined') await LetterboxdAdmissionAuthority.guardLegacyWrite(env);
      const saved = await env.BUCKET.put(key, JSON.stringify(next), {httpMetadata: {contentType: 'application/json'}, onlyIf: current.etag ? {etagMatches: current.etag} : {etagDoesNotMatch: '*'}});
      if (saved !== null) {
        await syncRegistry(env, key, next, saved && typeof saved.etag === 'string' ? saved.etag : null);
        return {value: next, changed: true};
      }
    }
    throw new Error('write_contention');
  }

  async function registerCandidates(env, {sha, generatedAt, chunk, rows}) {
    if (!HEX64.test(String(sha || ''))) throw new Error('invalid_archive');
    const key = CANDIDATES(sha);
    const added = [];
    const kept = [];
    const result = await casDoc(env, key, emptyDoc(sha, generatedAt), current => {
      if (current.archiveSha256 !== sha) return current;
      const decision = LetterboxdRatedAdmission.planRegistration(current, rows, generatedAt);
      added.length = 0; kept.length = 0;
      kept.push(...decision.keep, ...decision.skippedNewer);
      if (!decision.add.length) return null;
      for (const row of decision.add) {
        current.candidates[row.code] = {
          code: row.code, state: row.state, reason: row.reason || null, rating: row.rating, observedAt: generatedAt,
          name: row.name || null, year: row.year ?? null, historicalTmdb: row.historicalTmdb || null, tmdb: null,
          chunk, registeredAt: new Date().toISOString(), enrichment: null,
        };
        added.push(row.code);
      }
      return current;
    });
    return {added, kept, document: result.value, changed: result.changed};
  }

  function titleKey(name, year) {
    const norm = typeof LetterboxdMatch !== 'undefined' && LetterboxdMatch.normTitle ? LetterboxdMatch.normTitle(name) : String(name || '').normalize('NFKC').toLowerCase().trim();
    return norm + '|' + (year ?? '');
  }

  async function ownedMovieIds(env, doc, code, atD1 = false) {
    const ids = new Set();
    // AIR-602 / ADR 0207 decision 5: at `d1` the admitted movie ids are read from the D1 admission table, never from the frozen R2 object (which holds none of the admissions made since the flip).
    if (atD1) {
      for (const id of await LetterboxdAdmissionD1.admittedMovieIds(env, {exceptCode: code})) ids.add(String(id));
    } else {
      const admissions = await readDoc(env, ADMISSIONS);
      if (admissions.value === undefined) throw new Error('storage_unavailable');
      for (const film of Object.values((admissions.value && admissions.value.films) || {})) {
        if (film && film.tmdb && film.sourceCode !== code) ids.add(String(film.tmdb));
      }
    }
    for (const other of Object.values(doc.candidates || {})) {
      if (!other || other.code === code || other.state === 'removed') continue;
      if (other.tmdb) ids.add(String(other.tmdb));
      if (other.state === 'admitting' && other.intendedTmdb) ids.add(String(other.intendedTmdb));
    }
    if (typeof LetterboxdFacts !== 'undefined' && LetterboxdFacts.knownMovieIds) {
      for (const id of await LetterboxdFacts.knownMovieIds(env)) ids.add(String(id));
    }
    return ids;
  }

  // Observed owners only. An unfetched namesake is not given a fake page: same title and year stops before any write.
  function collisionQueue(doc, code, item, evidence) {
    const key = titleKey(item.name, item.year);
    const queue = [];
    const observations = new Map();
    for (const other of Object.values(doc.candidates || {})) {
      if (!other || other.code === code || other.state === 'removed') continue;
      if (key !== '|' && titleKey(other.name, other.year) === key && other.state !== 'verified' && other.state !== 'admitting') return {blocked: 'same_title_year'};
      const known = other.tmdb || (other.state === 'admitting' ? other.intendedTmdb : null);
      if (!known) continue;
      const path = other.filmPath || null;
      if (!path) continue;
      queue.push({code: other.code, group: 'unmatched', name: other.name || '', year: other.year ?? null, ledgerTmdbId: other.historicalTmdb || null});
      observations.set(other.code, {kind: 'page', path, shortCode: other.code, shortlinkPresent: true, canonicalPath: path, tmdbIds: [String(known)], tmdbTypes: ['movie'], title: other.name || '', aliases: [], years: Number.isInteger(other.year) ? [other.year] : []});
    }
    queue.push({code, group: 'unmatched', name: item.name || '', year: item.year ?? null, ledgerTmdbId: item.historicalTmdb || null});
    observations.set(code, evidence);
    return {queue, observations};
  }

  async function writeAdmission(env, film) {
    let refused = null;
    const result = await casDoc(env, ADMISSIONS, {schemaVersion: 1, films: {}}, current => {
      refused = null;
      for (const other of Object.values(current.films)) {
        if (!other || !other.sourceCode || !other.tmdb) continue;
        if (other.sourceCode === film.sourceCode && other.tmdb !== film.tmdb) {refused = 'historical_alias_conflict'; return null;}
        if (other.tmdb === film.tmdb && other.sourceCode !== film.sourceCode) {refused = 'duplicate_tmdb'; return null;}
      }
      const prior = current.films[film.filmId];
      if (prior && prior.tmdb === film.tmdb && prior.sourceCode === film.sourceCode) return null;
      if (prior && prior.sourceCode && prior.sourceCode !== film.sourceCode) {refused = 'duplicate_tmdb'; return null;}
      if (prior && prior.tmdb && prior.tmdb !== film.tmdb) {refused = 'historical_alias_conflict'; return null;}
      current.films[film.filmId] = {tmdb: film.tmdb, sourceCode: film.sourceCode, archiveSha256: film.archiveSha256, title: film.title || null, year: film.year, filmPath: film.filmPath || null, verifiedAt: prior && prior.verifiedAt || new Date().toISOString()};
      return current;
    });
    if (refused) return {ok: false, reason: refused};
    const stored = result.value && result.value.films && result.value.films[film.filmId];
    if (!stored) return {ok: false, reason: 'admission_missing'};
    if (stored.sourceCode !== film.sourceCode) return {ok: false, reason: 'duplicate_tmdb'};
    if (stored.tmdb !== film.tmdb) return {ok: false, reason: 'historical_alias_conflict'};
    return {ok: true, film: stored};
  }

  function stopFrom(error) {
    // AIR-604: an enforced shared cooldown skipped the request. It is a transport stop that costs no attempt (ADR 0207 decision 4b), not a network failure.
    if (error && error.code === 'upstream_cooldown') return {stop: 'upstream_cooldown', until: error.until};
    const name = error && error.name;
    if (name === 'TimeoutError' || name === 'AbortError') return {stop: 'timeout'};
    // AIR-599: `network` lets the Diary check classify this as `network_error`; every other caller keeps reading `fetch_failed`.
    return {stop: 'fetch_failed', network: true};
  }
  async function readBounded(response, limit) {
    const body = response && response.body;
    if (body && typeof body.getReader === 'function') {
      const reader = body.getReader();
      const chunks = [];
      let total = 0;
      try {
        while (true) {
          const step = await reader.read();
          if (step.done) break;
          const size = step.value ? step.value.byteLength : 0;
          total += size;
          if (total > limit) {try {await reader.cancel();} catch { /* the body is discarded */ } return {oversize: true};}
          if (step.value) chunks.push(step.value);
        }
      } catch (error) {return {error};}
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.byteLength;}
      return {text: new TextDecoder('utf-8', {fatal: false}).decode(bytes)};
    }
    let text;
    try {text = await response.text();} catch (error) {return {error};}
    if (text.length > limit) return {oversize: true};
    return {text};
  }
  async function boundedFetch(fetchImpl, url, init, timeout, limit) {
    let response;
    try {response = await fetchImpl(url, {...init, signal: AbortSignal.timeout(timeout)});} catch (error) {return stopFrom(error);}
    // AIR-604 (ADR 0211 decision 5). A known 429, 403 or challenge is recorded and is a TRANSPORT stop, the existing classifier's own word for it. It takes precedence over a body that is oversized or
    // unreadable, which would otherwise be a definite answer that charges an attempt. The status and the headers are checked FIRST, before the body is read (no body is read for a known signal);
    // a challenge page behind a 200 is found in the one bounded read below. Without a coordinator, and with `off`, nothing changes: `after` records nothing and returns null.
    const scope = fetchImpl.coordinator ? UpstreamCooldown.scopeOfUrl(url) : null;
    const record = async html => {
      if (!scope) return null;
      let signal = null;
      try {signal = await fetchImpl.coordinator.after(scope, {status: response.status, headers: response.headers, html});} catch { /* coordination never fails a check */ }
      return signal ? (LetterboxdIdentity.transportStop(response.status, response.headers, html) || null) : null;
    };
    const early = await record('');
    if (early) return {stop: early};
    const read = await readBounded(response, limit);
    const late = await record(read.text || '');
    if (late) return {stop: late};
    if (read.oversize) return {stop: 'oversized'};
    if (read.error) return stopFrom(read.error);
    return {response, text: read.text || ''};
  }

  async function follow(fetchImpl, code) {
    let url = 'https://boxd.it/' + code;
    let redirect = null; // AIR-673: the FIRST hop (the boxd.it redirect), additive: only the dormant lid-only proof reads it
    for (let hop = 0; hop < 4; hop++) {
      const fetched = await boundedFetch(fetchImpl, url, {redirect: 'manual', headers: {Accept: 'text/html'}}, PAGE_MS, PAGE_BYTES);
      if (fetched.stop) return fetched.network ? {stop: fetched.stop, network: true} : {stop: fetched.stop, ...(fetched.until !== undefined ? {until: fetched.until} : {})};
      const response = fetched.response;
      const status = response.status;
      const headers = response.headers;
      if (status >= 300 && status < 400) {
        const stop = LetterboxdIdentity.transportStop(status, headers, '');
        if (stop) return {stop};
        const next = LetterboxdIdentity.allowedHop(headers.get('location'), url);
        if (!next) return {review: 'blocked_redirect'};
        if (!redirect) redirect = {status, location: next.toString()};
        url = next.toString();
        continue;
      }
      const html = fetched.text;
      const stop = LetterboxdIdentity.transportStop(status, headers, html);
      if (stop) return {stop};
      if (status !== 200) return {review: 'fetch_failed', status}; // AIR-599: the status lets the Diary check split a 404 from a 5xx
      const landing = new URL(url);
      if (!LetterboxdIdentity.isFilmPage(landing)) return {review: 'not_film_page'};
      return {html, landing, redirect};
    }
    return {review: 'too_many_hops'};
  }

  // ADR 0217 decision 3 (AIR-670): every answer also carries its typed TMDB `state`, additively. `review`, `status` and `stop` are exactly as before, so the live callers (the Diary check, the Watchlist
  // admission step) behave unchanged; the typed state is what the dormant lid-only path reads. A `404` is its own state `tmdb_missing`; any other non-200 below 500, an unparseable and an oversized document are `tmdb_failed`;
  // a 5xx, a transport stop, a cooldown and a missing token are `tmdb_unavailable`. A usable document has no state here: whether it agrees is `movieDetailAgrees`.
  async function movieDetail(env, tmdb, fetchImpl) {
    if (!env || !env.TMDB_API_READ_ACCESS_TOKEN) return {stop: 'tmdb_unavailable', state: 'tmdb_unavailable'};
    const fetched = await boundedFetch(fetchImpl, 'https://api.themoviedb.org/3/movie/' + encodeURIComponent(tmdb) + '?language=en-US', {headers: {Authorization: 'Bearer ' + env.TMDB_API_READ_ACCESS_TOKEN, Accept: 'application/json'}}, DETAIL_MS, DETAIL_BYTES);
    const oversized = fetched.stop === 'oversized'; // a document over the cap is no transport stop: the classifier charges it, as a failed document
    if (fetched.stop) return fetched.network ? {stop: fetched.stop, network: true, state: 'tmdb_unavailable'} : {stop: fetched.stop, ...(fetched.until !== undefined ? {until: fetched.until} : {}), state: oversized ? 'tmdb_failed' : 'tmdb_unavailable'};
    const body = fetched.text;
    const stop = LetterboxdIdentity.transportStop(fetched.response.status, fetched.response.headers, body);
    if (stop) return {stop, state: 'tmdb_unavailable'};
    // AIR-599 keeps a TMDB 5xx a transport answer (`upstream_5xx`, no attempt), so its typed state is `tmdb_unavailable`, not `tmdb_failed`.
    if (fetched.response.status !== 200) return {review: 'tmdb_fetch_failed', status: fetched.response.status, state: fetched.response.status === 404 ? 'tmdb_missing' : fetched.response.status >= 500 ? 'tmdb_unavailable' : 'tmdb_failed'};
    try {return {detail: JSON.parse(body)};} catch {return {review: 'tmdb_fetch_failed', state: 'tmdb_failed'};}
  }

  async function writeRating(env, tmdb, item, generatedAt, sha) {
    const factKey = await LetterboxdFacts.linkTmdbOnly(env, tmdb);
    const watched = await LetterboxdFacts.observation({factKey, fact: 'watched', value: true, observedAt: generatedAt, source: 'letterboxd_export', sourceRef: sha});
    const rating = await LetterboxdFacts.observation({factKey, fact: 'rating', value: item.rating, observedAt: generatedAt, source: 'letterboxd_export', sourceRef: sha});
    const result = await LetterboxdFacts.recordObservations(env, factKey, {tmdb: String(tmdb)}, [{fact: 'watched', observation: watched}, {fact: 'rating', observation: rating}]);
    await LetterboxdFacts.projectRecords(env, [result.record]);
    const outcomes = Object.fromEntries(result.outcomes.map(entry => [entry.fact, entry.outcome]));
    return {factKey, outcomes, watchlist: Object.prototype.hasOwnProperty.call(result.record, 'watchlist')};
  }

  function sameClaim(row, tmdb, filmPath) {
    return !!(row && row.state === 'admitting' && row.intendedTmdb === String(tmdb) && row.filmPath === filmPath);
  }
  async function readClaim(env, key, code, tmdb, filmPath) {
    const opened = await readDoc(env, key);
    if (opened.value === undefined) return {ok: false, reason: 'storage_unavailable'};
    const row = opened.value && opened.value.candidates && opened.value.candidates[code];
    if (sameClaim(row, tmdb, filmPath)) return {ok: true, row};
    const reason = !row ? 'claim_missing' : row.state === 'removed' ? 'removed' : row.state === 'needs_review' ? 'needs_review' : row.state === 'admitting' ? 'intent_conflict' : 'claim_changed';
    return {ok: false, reason, state: row && row.state || null};
  }
  function reviewReasons(reason, extra) {
    const reasons = LetterboxdIdentity.boundReasons([reason, ...(extra || [])]);
    return {reason: reasons[0] || reason, reasons, reasonKind: LetterboxdIdentity.reasonKind(reasons)};
  }
  function withWrites(result, writes, persisted) {
    const reasons = result.reasons || (result.reason ? [result.reason] : []);
    return {
      ...result,
      writes: writes === true,
      persisted: persisted || 'none',
      reasons,
      reasonKind: result.reasonKind || (reasons.length ? LetterboxdIdentity.reasonKind(reasons) : null),
    };
  }
  // The ORIGINAL candidate (the row a step READ before it decided anything), compared exactly: state, kind, intended identity, path, proof digest, the observation and the movie. A disposition that rests on the original row's
  // intent or source writes only while the current row still equals it; a row replaced meanwhile is `claim_changed`, never reviewed, charged or settled on the old observer's behalf.
  const ORIGINAL_KEYS = ['state', 'kind', 'intendedTmdb', 'filmPath', 'proofDigest', 'rating', 'observedAt', 'tmdb'];
  const sameOriginal = (row, original) => !!row && !!original && ORIGINAL_KEYS.every(name => (row[name] ?? null) === (original[name] ?? null));
  async function markReview(env, key, code, reason, claim, extra, {guard = null} = {}) {
    const payload = reviewReasons(reason, extra);
    const saved = await casDoc(env, key, null, current => {
      const row = current.candidates[code];
      if (!row || row.state === 'verified' || row.state === 'removed') return null;
      if (claim && !(claim.original ? sameOriginal(row, claim.original) : claim.lidOnly ? sameLidIntent(row, claim.filmPath, claim.proofDigest, claim.item) : sameClaim(row, claim.tmdb, claim.filmPath))) return null;
      current.candidates[code] = {...row, state: 'needs_review', reason: payload.reason, reasons: payload.reasons, reasonKind: payload.reasonKind, intendedTmdb: null};
      current.checkpoint = {...(current.checkpoint || {}), cursor: code, stopped: null};
      return current;
    }, {extra: guard ? [guard.statement] : []});
    return {...payload, changed: saved.changed === true, refused: saved.refused === true};
  }
  // AIR-602 (review of PR #1018), at `d1`: an `admitting` row whose source cannot be reacquired NOW stays `admitting` (retried); each such answer costs one attempt and the sixth makes the row `needs_review`
  // (ADR 0207 decision 3 table, rated step). Nothing is marked for review on a first transport-like answer, and nothing is admitted from the stored intent.
  const SOURCE_ATTEMPT_CAP = 6;
  async function retryAdmitting(env, key, code, reason, guard = null, original = null) {
    // PR #1018 review: the charge and the disposition are ONE compare-and-swap. A source answer that is not the cap only counts an attempt (unguarded: nothing terminal happens); the answer that REACHES the cap writes the
    // counter and the terminal `needs_review` together, in the same batch as the history assertion the step's reconcile observed, so a refused terminal outcome leaves no stale charge and the row keeps its intent.
    const payload = reviewReasons('source_unavailable');
    for (let round = 0; round < 3; round++) {
      const peek = await readDoc(env, key);
      if (peek.value === undefined) throw new Error('storage_unavailable');
      const seen = peek.value && peek.value.candidates && peek.value.candidates[code];
      if (!seen || seen.state !== 'admitting' || (original && !sameOriginal(seen, original))) return {pending: true, fetched: true, verified: false, code, state: 'admitting', reason: 'source_unavailable', phase: 'identity', writes: false};
      const capping = (Number.isInteger(seen.sourceAttempts) ? seen.sourceAttempts : 0) + 1 >= SOURCE_ATTEMPT_CAP;
      let attempts = 0, terminal = false, moved = false;
      const saved = await casDoc(env, key, null, current => {
        const row = current.candidates[code];
        if (!row || row.state !== 'admitting' || (original && !sameOriginal(row, original))) return null;
        attempts = (Number.isInteger(row.sourceAttempts) ? row.sourceAttempts : 0) + 1;
        const counted = {...row, sourceAttempts: attempts, sourceReason: String(reason).slice(0, 60)};
        if (attempts >= SOURCE_ATTEMPT_CAP) {
          // the document moved between the peek and this write and now reaches the cap without the assertion in the batch: replan
          if (!capping) {moved = true; return null;}
          current.candidates[code] = {...counted, state: 'needs_review', reason: payload.reason, reasons: payload.reasons, reasonKind: payload.reasonKind, intendedTmdb: null};
          current.checkpoint = {...(current.checkpoint || {}), cursor: code, stopped: null};
          terminal = true;
        } else current.candidates[code] = counted;
        return current;
      }, {extra: capping && guard ? [guard.statement] : []});
      if (moved) continue;
      if (saved.refused) return {pending: true, fetched: true, verified: false, code, state: 'admitting', reason: 'in_flight', phase: 'identity', writes: false};
      if (terminal) return {pending: true, fetched: true, verified: false, code, state: 'needs_review', reason: payload.reason, reasons: payload.reasons, reasonKind: payload.reasonKind, phase: 'identity', writes: saved.changed === true};
      return {pending: true, fetched: true, verified: false, code, state: 'admitting', reason: 'source_unavailable', phase: 'identity', writes: attempts > 0};
    }
    throw new Error('write_contention');
  }
  // A terminal review of an `admitting` row at `d1` is ONE D1 batch with the operation-history assertion (ADR 0222): the document write and `guard.statement` commit together or not at all. A moved history refuses
  // the batch, nothing is written, and the row stays `admitting` for the next step to replan from the reconciled state.
  async function reviewBehindGuard(env, key, code, reason, guard, claim) {
    const review = await markReview(env, key, code, reason, claim, undefined, {guard});
    if (review.refused) return {pending: true, fetched: true, verified: false, code, state: 'admitting', reason: 'in_flight', phase: 'identity', writes: false};
    // An exact claim that no longer matches reviewed nothing: the row is another row, left as it is.
    if (claim && !review.changed) return refusedClaim(code, 'claim_changed');
    return {pending: true, fetched: true, verified: false, code, state: 'needs_review', reason: review.reason, reasons: review.reasons, reasonKind: review.reasonKind, phase: 'identity', writes: review.changed === true};
  }
  async function park(env, key, doc, stopped) {
    return casDoc(env, key, doc, current => {current.checkpoint = {...(current.checkpoint || {}), stopped}; return current;});
  }

  function refusedClaim(code, outcome) {
    const state = outcome === 'intent_conflict' ? 'admitting' : outcome === 'verified_conflict' || outcome === 'already' ? 'verified' : outcome === 'removed' || outcome === 'needs_review' ? outcome : 'pending';
    return {pending: true, fetched: true, verified: false, code, state, reason: outcome, phase: 'identity'};
  }
  async function applyCanonicalRatedAdmission(env, event, receiptKey, receipt) {
    if (typeof CanonicalRatedAdmission === 'undefined' || !receipt) return;
    const out = await CanonicalRatedAdmission.applyRatedAdmissionRetention(env, {
      event,
      admissions: [{receiptKey, receipt}],
    });
    CanonicalRatedAdmission.assertRatedAdmissionAccepted(out);
  }
  // Fence the intended movie, read it back, then admit that one source code and only then write the rating.
  // A removed, reviewed or differently claimed row is not admitted and is not marked verified.
  async function digestHex(value) {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }
  // AIR-602 / ADR 0207 decisions 2 and 3, at the marker mode `d1`: the admission of this verified code goes through the D1 coordinator (one key `admission:lid:<code>`, keep-first, the evidence row of THIS archive's
  // page check in the same batch), not the R2 entry. The typed outcome is mapped onto the legacy refusal vocabulary of this step: a settled pair is `ok`; another code on the Film is `duplicate_tmdb`; a code held by
  // another Film is `historical_alias_conflict` (both `needs_review`); everything non-terminal (an identity held or redirected, a live attempt, a failed or deferred attempt) keeps the row `admitting` and is retried.
  async function admitRatedAtD1(env, film, code, sha, evidence, {intended = null} = {}) {
    const root = await digestHex({code, path: film.filmPath || null, tmdb: film.tmdb, title: film.title, year: film.year, source: 'letterboxd_rated_archive_page'});
    const at = new Date().toISOString();
    const out = await LetterboxdAdmissionD1.admitVerifiedFilm(env, {kind: 'lid', lid: code, intent: intended ? {tmdb: intended} : null, receipt: {tmdb: film.tmdb, archiveSha256: sha, title: film.title, year: film.year, filmPath: film.filmPath || null},
      evidence: {subject: {kind: 'letterboxd_short_code', value: code}, relation: 'same_work', object: {kind: 'tmdb_movie', value: film.tmdb}, polarity: 'asserts', route: 'letterboxd_rated_archive', method: 'page_check', sourceRoot: root, sourceRef: 'archive-step:' + sha.slice(0, 12), sourceScope: sha, observedAt: at},
      // ADR 0222: the terminal review is the row's own D1 document write, committed in ONE batch with the history assertion of this attempt (`guard.statement`); a refused batch writes nothing and the attempt replans.
      finalize: async (result, guard) => {
        const reason = result.outcome === 'other_code' ? 'duplicate_tmdb' : result.outcome === 'conflict' ? 'historical_alias_conflict' : 'source_changed';
        const review = await markReview(env, CANDIDATES(sha), code, reason, {tmdb: String(film.tmdb), filmPath: film.filmPath || null}, undefined, {guard});
        return review.refused ? {refused: true} : {reviewed: true, reason: review.reason, reasons: review.reasons, reasonKind: review.reasonKind, changed: review.changed};
      },
      now: () => new Date().toISOString()});
    if (out.outcome === 'admitted' || out.outcome === 'present') return {ok: true};
    // A typed refusal is terminal ONLY when it was finalized with its history assertion (`finalize`). One that surfaced from a reservation that lost a race left its receipt unresolved: it is non-terminal, the
    // row keeps its intent and the next step reconciles the key and replans (PR #1018 review).
    const finalized = out.finalized?.reviewed === true;
    if (out.outcome === 'other_code') return finalized ? {ok: false, reason: 'duplicate_tmdb', reviewed: true} : {ok: false, retry: true, reason: 'deferred'};
    if (out.outcome === 'conflict') return finalized ? {ok: false, reason: 'historical_alias_conflict', reviewed: true} : {ok: false, retry: true, reason: 'deferred'};
    if (out.outcome === 'source_changed') return finalized ? {ok: false, sourceChanged: true, reason: 'source_changed', reviewed: true} : {ok: false, sourceChanged: true, reason: 'source_changed', reviewed: false};
    if (out.outcome === 'deferred' && out.reason === 'evidence_unrecorded') return {ok: false, retry: true, reason: 'evidence_unrecorded', pendingEvidence: out.pendingEvidence};
    return {ok: false, retry: true, reason: out.outcome === 'held' || out.outcome === 'redirect' ? 'admission_held' : out.outcome === 'wait' ? 'in_flight' : 'deferred'};
  }
  async function commitVerified(env, sha, code, item, tmdb, evidence, generatedAt, atD1 = false, recover = {}) {
    const key = CANDIDATES(sha);
    const film = LetterboxdRatedAdmission.admissionFilm({tmdb, sourceCode: code, archiveSha256: sha, title: evidence.title || item.name, year: (evidence.years && evidence.years[0]) || item.year});
    if (!film) return {pending: true, fetched: true, verified: false, code, state: 'needs_review', reason: 'invalid_identity', phase: 'identity'};
    film.filmPath = evidence.path || item.filmPath || null;
    let outcome = 'missing';
    await casDoc(env, key, emptyDoc(sha, generatedAt), current => {
      const row = current.candidates[code];
      if (!row) {outcome = 'missing'; return null;}
      if (row.state === 'removed' || row.state === 'needs_review') {outcome = row.state; return null;}
      if (row.state === 'verified') {
        outcome = row.tmdb === String(tmdb) && row.filmPath === film.filmPath ? 'already' : 'verified_conflict';
        return null;
      }
      if (row.state === 'admitting') {
        // A LID-only original (the reverse mismatch): a row replaced meanwhile is `claim_changed`, never reviewed by this attempt. The legacy TMDB protocol is unchanged.
        if (item.kind === 'lid_only' && !sameOriginal(row, item)) {outcome = 'claim_changed'; return null;}
        outcome = row.intendedTmdb === String(tmdb) && row.filmPath === film.filmPath ? 'held' : 'intent_conflict';
        return null;
      }
      if (row.state !== 'pending') {outcome = 'claim_changed'; return null;}
      current.candidates[code] = {...row, state: 'admitting', intendedTmdb: String(tmdb), filmPath: film.filmPath, enrichment: 'pending', reason: null, ...(atD1 ? {evidenceDue: true} : {})};
      current.checkpoint = {...(current.checkpoint || {}), cursor: code, stopped: null};
      outcome = 'claimed';
      return current;
    });
    if (outcome === 'already') {
      if (atD1) await admitRatedAtD1(env, film, code, sha, evidence);
      else {
        const stored = await writeAdmission(env, film);
        if (stored.ok) await applyCanonicalRatedAdmission(env, 'rated:' + sha + ':' + code, film.filmId, stored.film);
      }
      return {pending: true, fetched: true, verified: true, code, tmdb: String(tmdb), filmId: film.filmId, phase: 'identity'};
    }
    // At `d1` a recovering row whose reacquired movie or page path differs from its intent is a CHANGED source (not a stale intent_conflict): needs_review `source_changed`, behind the history guard.
    if (atD1 && outcome === 'intent_conflict') return reviewBehindGuard(env, key, code, 'source_changed', recover.guard || null, item.kind === 'lid_only' ? {original: item} : undefined);
    if (outcome !== 'claimed' && outcome !== 'held') return refusedClaim(code, outcome);
    const held = await readClaim(env, key, code, tmdb, film.filmPath);
    if (!held.ok) return refusedClaim(code, held.reason);
    let admitted;
    // A row finished from its applied attempt (`recover.settled`) made no check: it records no evidence and needs no admission.
    if (atD1 && recover.settled) admitted = {ok: true};
    else if (atD1) admitted = await admitRatedAtD1(env, film, code, sha, evidence, {intended: recover.intended || null});
    else {
      admitted = await writeAdmission(env, film);
      if (admitted.ok) await applyCanonicalRatedAdmission(env, 'rated:' + sha + ':' + code, film.filmId, admitted.film);
    }
    // A non-terminal answer of the coordinator keeps the row `admitting`: the same identity is repeated by a later step, nothing is marked for review.
    // The terminal review of this attempt was already committed with its own history assertion (`finalize`): report it, never write it twice.
    if (admitted.reviewed) return {pending: true, fetched: true, verified: false, code, state: 'needs_review', reason: admitted.reason, phase: 'identity', writes: true};
    if (admitted.sourceChanged) return reviewBehindGuard(env, key, code, 'source_changed', recover.guard || null);
    if (admitted.retry) {
      // The pair is admitted but the evidence of THIS check is not proven recorded: the row stays `admitting` and keeps the evidence to record, so a retry records it without a fetch and only then finishes.
      if (admitted.pendingEvidence) await casDoc(env, key, null, current => {const row = current.candidates[code]; if (!row || row.state !== 'admitting') return null; current.candidates[code] = {...row, pendingEvidence: admitted.pendingEvidence}; return current;});
      return {pending: true, fetched: true, verified: false, code, state: 'admitting', reason: admitted.reason, phase: 'identity'};
    }
    if (!admitted.ok) {
      // A refusal at d1 is terminal only through `finalize` (handled above); anything else here is not terminal. Legacy (R2 entry) refusals keep the delivered behavior.
      if (atD1) return {pending: true, fetched: true, verified: false, code, state: 'admitting', reason: admitted.reason || 'deferred', phase: 'identity'};
      const still = await readClaim(env, key, code, tmdb, film.filmPath);
      if (still.ok) await markReview(env, key, code, admitted.reason, {tmdb, filmPath: film.filmPath});
      return {pending: true, fetched: true, verified: false, code, state: still.ok ? 'needs_review' : still.state || 'pending', reason: still.ok ? admitted.reason : still.reason, phase: 'identity'};
    }
    const beforeRating = await readClaim(env, key, code, tmdb, film.filmPath);
    if (!beforeRating.ok) return refusedClaim(code, beforeRating.reason);
    const rating = await writeRating(env, tmdb, item, generatedAt, sha);
    await casDoc(env, key, emptyDoc(sha, generatedAt), current => {
      const row = current.candidates[code];
      if (!sameClaim(row, tmdb, film.filmPath)) return null;
      // At `d1` enrichment is retired from this step (ADR 0207 decision 6): the row is verified with nothing left to enrich in R2.
      current.candidates[code] = {...row, state: 'verified', tmdb: String(tmdb), filmPath: film.filmPath, enrichment: atD1 ? 'done' : (row.enrichment || 'pending'), intendedTmdb: null, reason: null, ...(atD1 ? {evidenceDue: false} : {})};
      current.checkpoint = {...(current.checkpoint || {}), cursor: code, stopped: null};
      return current;
    });
    const after = await readDoc(env, key);
    const row = after.value && after.value.candidates && after.value.candidates[code];
    if (!row || row.state !== 'verified' || row.tmdb !== String(tmdb) || row.filmPath !== film.filmPath) return refusedClaim(code, 'claim_changed');
    return {pending: true, fetched: true, verified: true, code, tmdb: String(tmdb), rating: rating.outcomes, filmId: film.filmId, phase: 'identity'};
  }

  // AIR-673 / ADR 0217 decision 9 (delivery step 4), DORMANT: the rated archive candidate of a lid-only Film. The page proved (H1, `lidOnlyPageProof`, whose rules ship EMPTY: no page can pass until step 8) that the film has no TMDB
  // movie; the coordinator's `lid_only` kind admits the Film `film:lb:<lid>` and the candidate becomes `verified` with `tmdb: null`, its watched/rating facts written under the lid's own fact key `lb-<lid>` and NO TMDB alias.
  // The durable intent is the row itself: `admitting` with `kind: 'lid_only'`, `intendedTmdb: null` and the page path (`filmPath`), claimed by an exact compare-and-swap from `pending`. A row that already holds a
  // DIFFERENT intent (another path, or a TMDB intent) is a changed source: reviewed behind the history guard. The existing TMDB path is untouched.
  async function writeLidRating(env, code, row, generatedAt, sha, extra = []) {
    // Every effect carries the settlement assertions (`extra`: the current ownership and the candidate document the attempt read) IN ITS OWN D1 batch, and the lid-only contract holds at the effect: the link and the
    // record land on exactly `lb-<lid>`, with no movie alias, id or redirect. The facts are derived from `row`, the SAME snapshot the document fence was taken from. An effect whose guard is false commits nothing;
    // effects that already committed (valid then) are kept, never rolled back.
    const factKey = await LetterboxdFacts.linkLidOnly(env, code, {extra});
    // The positive observation of the links document AFTER our own link: a movie alias onto the same key before the record or projection batch changes its version and fails those batches (the same fence, no new mechanism).
    const links = await LetterboxdFacts.linksObservation(env, code);
    if (links.tmdbAlias || links.factKey !== factKey) throw Object.assign(new Error('alias_conflict'), {code: 'alias_conflict'});
    const effectExtra = [...extra, LetterboxdAdmissionD1.lidOnlyDocumentFence(links.fence)];
    const watched = await LetterboxdFacts.observation({factKey, fact: 'watched', value: true, observedAt: generatedAt, source: 'letterboxd_export', sourceRef: sha});
    const rating = await LetterboxdFacts.observation({factKey, fact: 'rating', value: row.rating, observedAt: generatedAt, source: 'letterboxd_export', sourceRef: sha});
    const result = await LetterboxdFacts.recordObservations(env, factKey, {letterboxd: String(code)}, [{fact: 'watched', observation: watched}, {fact: 'rating', observation: rating}], {extra: effectExtra, lidOnly: true});
    await LetterboxdFacts.projectRecords(env, [result.record], {extra: effectExtra});
    const outcomes = Object.fromEntries(result.outcomes.map(entry => [entry.fact, entry.outcome]));
    return {factKey, outcomes};
  }
  // `item` (the row this attempt read) makes the intent EXACT: the rating and the observation time are the observation the attempt writes; a replacement that keeps the path and the digest but changes either is another row.
  const sameLidIntent = (row, filmPath, proofDigest, item) => !!(row && row.state === 'admitting' && row.kind === 'lid_only' && row.intendedTmdb === null && row.filmPath === filmPath && row.proofDigest === proofDigest && (!item || (row.rating === item.rating && row.observedAt === item.observedAt)));
  async function commitLidOnly(env, sha, code, item, proof, generatedAt, recover = {}) {
    const key = CANDIDATES(sha);
    const filmPath = proof.proof.canonicalPath, proofDigest = proof.proof.proofDigest;
    let outcome = 'missing';
    await casDoc(env, key, emptyDoc(sha, generatedAt), current => {
      const row = current.candidates[code];
      if (!row) {outcome = 'missing'; return null;}
      if (row.state === 'removed' || row.state === 'needs_review') {outcome = row.state; return null;}
      if (row.state === 'verified') {outcome = row.kind === 'lid_only' && row.tmdb == null && row.filmPath === filmPath && row.proofDigest === proofDigest && row.rating === item.rating && row.observedAt === item.observedAt ? 'already' : 'verified_conflict'; return null;}
      if (row.state === 'admitting') {
        // The row this attempt READ, unchanged, with a changed source is a real mismatched intent (`source_changed`); a row that is not the original any more was REPLACED meanwhile: never reviewed by this attempt.
        outcome = sameLidIntent(row, filmPath, proofDigest, item) ? 'held' : sameOriginal(row, item) ? 'intent_conflict' : 'claim_changed';
        return null;
      }
      if (row.state !== 'pending') {outcome = 'claim_changed'; return null;}
      // Only the row this attempt READ is claimed: a pending row replaced meanwhile (another rating or observation) is not adopted.
      if (row.rating !== item.rating || row.observedAt !== item.observedAt) {outcome = 'claim_changed'; return null;}
      current.candidates[code] = {...row, state: 'admitting', kind: 'lid_only', intendedTmdb: null, filmPath, proofDigest, enrichment: 'pending', reason: null};
      current.checkpoint = {...(current.checkpoint || {}), cursor: code, stopped: null};
      outcome = 'claimed';
      return current;
    });
    if (outcome === 'intent_conflict') return reviewBehindGuard(env, key, code, 'source_changed', recover.guard || null, {original: item});
    if (outcome !== 'claimed' && outcome !== 'held' && outcome !== 'already') return refusedClaim(code, outcome);
    const heldNow = async () => {const opened = await readDoc(env, key); const row = opened.value && opened.value.candidates && opened.value.candidates[code]; return opened.value === undefined ? {ok: false, reason: 'storage_unavailable'} : (outcome === 'already' ? (row && row.state === 'verified' && row.kind === 'lid_only' && row.filmPath === filmPath && row.proofDigest === proofDigest && row.rating === item.rating && row.observedAt === item.observedAt ? {ok: true} : {ok: false, reason: 'claim_changed'}) : sameLidIntent(row, filmPath, proofDigest, item) ? {ok: true} : {ok: false, reason: !row ? 'claim_missing' : row.state === 'needs_review' ? 'needs_review' : row.state === 'removed' ? 'removed' : 'claim_changed'});};
    const held = await heldNow();
    if (!held.ok) return refusedClaim(code, held.reason);
    // The coordinator: the page proof is the one this step just made; the links observation is read FRESH here and fenced inside the canonical batch, so a link written in between fails the batch whole.
    let admitted;
    try {
      // A row that already held this durable intent (`held`: an earlier attempt persisted it) passes it to the coordinator, so an applied attempt of ANOTHER proof is never taken for its own replay.
      admitted = await LetterboxdAdmissionD1.admitVerifiedLidOnly(env, {
        lid: code, route: 'letterboxd_rated_archive',
        ...(outcome === 'held' ? {intent: {proofDigest}} : {}),
        reacquire: async () => {try {return {ok: true, proof: proof.proof, links: await LetterboxdFacts.linksObservation(env, code)};} catch (error) {return {ok: false, reason: 'source_unavailable'};}},
        finalize: async (result, guard) => {
          const reason = result.outcome === 'conflict' ? 'lid_only_conflict' : 'source_changed';
          // The terminal disposition carries the EXACT candidate this attempt owns: a replaced row is neither reviewed nor reported reviewed by the stale attempt.
          const review = await markReview(env, key, code, reason, {lidOnly: true, filmPath, proofDigest, item}, undefined, {guard});
          if (!review.changed && !review.refused) return {refused: true};
          return review.refused ? {refused: true} : {reviewed: true, reason: review.reason, reasons: review.reasons, reasonKind: review.reasonKind, changed: review.changed};
        },
        now: () => new Date().toISOString()});
    } catch (error) {
      return {pending: true, fetched: true, verified: false, code, state: 'admitting', reason: error && error.code === 'admission_closed' ? 'admission_closed' : 'deferred', phase: 'identity'};
    }
    if (admitted.finalized?.reviewed === true) return {pending: true, fetched: true, verified: false, code, state: 'needs_review', reason: admitted.finalized.reason, phase: 'identity', writes: true};
    // A lid already trusted on a TMDB Film (case 4b) contradicts a page that names no movie: the candidate is reviewed, never admitted twice and never attached by this path.
    if (admitted.outcome === 'present') {
      const review = await reviewBehindGuard(env, key, code, 'lid_on_tmdb_film', recover.guard || null, {lidOnly: true, filmPath, proofDigest, item});
      return review;
    }
    if (admitted.outcome === 'held' && admitted.reason === 'ratings_tmdb_link') {
      // The Ratings link of the lid names a movie the page does not: counted like any unreacquirable source (six attempts, then review).
      const kept = await retryAdmitting(env, key, code, 'ratings_tmdb_link', recover.guard || null, {state: 'admitting', kind: 'lid_only', intendedTmdb: null, filmPath, proofDigest, rating: item.rating, observedAt: item.observedAt, tmdb: item.tmdb ?? null});
      return {...kept, fetched: true};
    }
    if (admitted.outcome !== 'admitted_lid_only' && admitted.outcome !== 'present_lid_only') {
      return {pending: true, fetched: true, verified: false, code, state: 'admitting', reason: admitted.reason || (admitted.outcome === 'wait' ? 'in_flight' : 'deferred'), phase: 'identity'};
    }
    const filmId = admitted.id;
    if (typeof filmId !== 'string' || !filmId.startsWith('film:')) return {pending: true, fetched: true, verified: false, code, state: 'admitting', reason: 'deferred', phase: 'identity'};
    // REPLAY (this attempt's own applied receipt must stand) for a newly applied attempt, a proven replay from the receipt and a recovery of the persisted intent; PRESENT (ownership alone, no receipt of its own) for a Film
    // another route proved independently.
    const ownAttempt = admitted.outcome === 'admitted_lid_only' || admitted.ownReplay === true;
    return settleLidOnly(env, sha, code, item, {filmPath, proofDigest, filmId, requestId: ownAttempt ? admitted.requestId || null : null, replay: ownAttempt, already: outcome === 'already', fetched: true, generatedAt, guard: recover.guard || null});
  }
  // The ONE settlement of a lid-only candidate (a newly applied attempt, an already-present Film and the recovery from an applied receipt). The current candidate row is read before any fact is written; the facts go to the lid's own
  // fact key (a movie alias that appeared meanwhile is `alias_conflict`: reviewed, never reported verified); and the terminal `verified` write is a document compare-and-swap that carries, in the same D1 batch, the complete current
  // ownership of the lid by the resolved Film and, for this attempt's own proof row, its own applied receipt. A refused batch writes nothing and leaves the row `admitting`.
  async function settleLidOnly(env, sha, code, item, {filmPath, proofDigest, filmId, requestId, replay, already, fetched, generatedAt, guard}) {
    const key = CANDIDATES(sha);
    // The row this attempt may settle, EXACT: kind, no movie, page path, proof digest and the observation it writes (rating and time). `already` is a verified row of the same exact intent.
    const matches = row => already ? !!(row && row.state === 'verified' && row.kind === 'lid_only' && row.filmPath === filmPath && row.proofDigest === proofDigest && row.rating === item.rating && row.observedAt === item.observedAt) : sameLidIntent(row, filmPath, proofDigest, item);
    const whyNot = row => !row ? 'claim_missing' : row.state === 'needs_review' ? 'needs_review' : row.state === 'removed' ? 'removed' : 'claim_changed';
    // The assertions every effect and the terminal write carry, built BEFORE the first effect: complete current ownership (replay of the attempt's own receipt, or an independently proved present Film).
    const owned = await LetterboxdAdmissionD1.lidOnlySettlementGuard({lid: code, filmId, proofDigest, requestId, replay: replay === true});
    if (typeof RatingsD1 === 'undefined') return {pending: true, fetched, verified: false, code, state: 'admitting', reason: 'deferred', phase: 'identity'};
    let rating = null;
    // At most three snapshots: a change of ANOTHER candidate (the document version moved) is retried, but only while THIS row still matches exactly.
    for (let attempt = 0; attempt < 3 && !rating; attempt++) {
      // ONE authoritative snapshot: the candidate value and the version fence of the same read. The facts are derived from this row and the fence authenticates exactly this version.
      const observed = await RatingsD1.observeOwned(env, key, {admission: true});
      if (!observed.owned || observed.value === undefined) return {pending: true, fetched, verified: false, code, state: 'admitting', reason: 'deferred', phase: 'identity'};
      const row = observed.value && observed.value.candidates && observed.value.candidates[code];
      if (!matches(row)) return refusedClaim(code, whyNot(row));
      const guards = [owned, LetterboxdAdmissionD1.lidOnlyDocumentFence(observed.fence)];
      try {
        rating = await writeLidRating(env, code, row, generatedAt, sha, guards);
      } catch (error) {
        if (error && error.code === 'alias_conflict') {
          // Reviewed only while the EXACT row this attempt owns still stands; a replaced row is never reviewed by a stale attempt.
          const review = await markReview(env, key, code, 'ratings_tmdb_link', {lidOnly: true, filmPath, proofDigest, item}, undefined, {guard});
          if (!review.changed && !review.refused) return refusedClaim(code, 'claim_changed');
          return {pending: true, fetched, verified: false, code, state: review.refused ? 'admitting' : 'needs_review', reason: review.refused ? 'in_flight' : review.reason, phase: 'identity', writes: review.changed === true};
        }
        // A guard that is false (the ownership changed, the candidate document moved, or a movie alias appeared) refuses the effect's own batch: nothing new commits. The loop re-reads and retries only while this exact row stands.
        if (error && (error.code === 'write_contention' || error.code === 'ratings_domain_fence' || error.code === 'atomic_unavailable')) continue;
        throw error;
      }
    }
    if (!rating) return {pending: true, fetched, verified: false, code, state: 'admitting', reason: 'ownership_changed', phase: 'identity'};
    // The terminal write is itself the compare-and-swap of the candidate document (its own version check), and its apply accepts ONLY the exact row this attempt owns; only the ownership assertion rides with it.
    const saved = await casDoc(env, key, emptyDoc(sha, generatedAt), current => {
      const row = current.candidates[code];
      if (!matches(row)) return null;
      if (row.state === 'verified') return null;
      // Enrichment is retired at `d1` and a lid-only Film is outside its scope (ADR 0211, ADR 0217 decision 9): nothing is left to enrich.
      current.candidates[code] = {...row, state: 'verified', kind: 'lid_only', tmdb: null, filmPath, proofDigest, filmId, enrichment: 'done', intendedTmdb: null, reason: null};
      current.checkpoint = {...(current.checkpoint || {}), cursor: code, stopped: null};
      return current;
    }, {extra: [owned]});
    if (saved.refused === true) return {pending: true, fetched, verified: false, code, state: 'admitting', reason: 'ownership_changed', phase: 'identity'};
    const after = await readDoc(env, key);
    const row = after.value && after.value.candidates && after.value.candidates[code];
    if (!row || row.state !== 'verified' || row.kind !== 'lid_only' || row.filmPath !== filmPath || row.proofDigest !== proofDigest || row.rating !== item.rating || row.observedAt !== item.observedAt) return refusedClaim(code, 'claim_changed');
    return {pending: true, fetched, verified: true, code, tmdb: null, lidOnly: true, rating: rating.outcomes, filmId, phase: 'identity'};
  }
  // The recovery of an applied lid-only attempt: no page, no proof and no coordinator call. The coordinator's reconcile (`present_lid_only`, `fromReceipt`) named the resolved Film; the row's own exact intent (path and proof digest)
  // is checked, the settlement fence asserts the same applied receipt and the complete current ownership, and every write is the same idempotent one as in `commitLidOnly`.
  async function finishLidOnlyFromReceipt(env, sha, code, item, generatedAt, settled) {
    return settleLidOnly(env, sha, code, item, {filmPath: item.filmPath, proofDigest: item.proofDigest, filmId: settled && settled.id, requestId: (settled && settled.requestId) || null, replay: true, already: false, fetched: false, generatedAt, guard: null});
  }

  function peopleOf(list) {
    return (Array.isArray(list) ? list : []).filter(person => person && typeof person.id === 'string').slice(0, 10).map(person => ({id: person.id, original: person.original || person.name || null, name: person.name || person.original || null}));
  }
  // `expected` is the admission the page was proven against. A row that changed ownership, TMDB id, archive or path between the
  // read and this write is left untouched (AIR-354).
  function sameAdmission(row, expected) {
    return !!row && !!expected && row.sourceCode === expected.sourceCode && String(row.tmdb) === String(expected.tmdb) && row.archiveSha256 === expected.archiveSha256 && row.filmPath === expected.filmPath;
  }
  // `refused` is true only when the compare-and-set found another owner; `changed:false` alone can also mean an identical payload.
  async function storeMetadata(env, filmId, parsed, filmPath, expected) {
    let refused = false;
    const saved = await casDoc(env, ADMISSIONS, {schemaVersion: 1, films: {}}, current => {
      refused = false;
      const prior = current.films[filmId];
      if (!prior) {refused = true; return null;}
      if (!sameAdmission(prior, expected)) {refused = true; return null;}
      prior.synopsis = parsed.synopsis || null;
      prior.synopsisFetchedAt = parsed.synopsisFetchedAt || null;
      prior.metadataAt = parsed.metadataAt || null;
      prior.directors = peopleOf(parsed.directors);
      prior.actors = peopleOf(parsed.actors);
      prior.genres = Array.isArray(parsed.genres) ? parsed.genres.slice(0, 12) : [];
      prior.runtime = Number.isInteger(parsed.runtime) ? parsed.runtime : null;
      prior.poster = typeof parsed.poster === 'string' ? parsed.poster : null;
      prior.peopleVersion = 1;
      prior.url = 'https://letterboxd.com' + filmPath;
      return current;
    });
    return {...saved, refused};
  }
  async function storeLocalization(env, filmId, film, titles, expected) {
    const cached = titles[film.id];
    let refused = false;
    const saved = await casDoc(env, ADMISSIONS, {schemaVersion: 1, films: {}}, current => {
      refused = false;
      const prior = current.films[filmId];
      if (!prior || !sameAdmission(prior, expected)) {refused = true; return null;}
      if (cached && cached.title) {prior.titleRu = cached.title; prior.titleStatus = cached.status || 'provisional';}
      prior.directors = peopleOf(film.directors);
      prior.actors = peopleOf(film.actors);
      prior.peopleNamesVersion = 2;
      prior.peopleLocalizedAt = new Date().toISOString();
      return current;
    });
    return {...saved, refused};
  }

  // A present shortlink must name this code. An absent one is accepted only when the persisted admission itself proves the code:
  // ownChecks admitted it on a shortlink or on the boxd.it redirect hop, and the row still names this code, archive, TMDB id and path (AIR-354).
  function enrichmentAgrees(html, film, code, sha, item) {
    let evidence;
    try {evidence = LetterboxdIdentity.pageEvidence(html, new URL('https://letterboxd.com' + film.filmPath), letterboxdPageTools());}
    catch {return {ok: false, reason: 'metadata_unparsed'};}
    if (!evidence || evidence.kind !== 'page') return {ok: false, reason: 'metadata_unparsed'};
    if (evidence.path !== film.filmPath) return {ok: false, reason: 'path_mismatch'};
    if (evidence.shortlinkPresent) {
      if (evidence.shortCode !== code) return {ok: false, reason: 'shortlink_mismatch'};
    } else if (film.sourceCode !== code || film.archiveSha256 !== sha || !film.tmdb || !film.filmPath || !item || item.state !== 'verified' || String(item.tmdb) !== String(film.tmdb) || item.filmPath !== film.filmPath) return {ok: false, reason: 'admission_unproven'};
    if (evidence.canonicalPath !== film.filmPath) return {ok: false, reason: 'canonical_mismatch'};
    if (!(evidence.tmdbTypes.length === 1 && evidence.tmdbTypes[0] === 'movie')) return {ok: false, reason: evidence.tmdbTypes.includes('tv') ? 'tmdb_tv' : 'tmdb_not_movie'};
    if (evidence.tmdbIds.length !== 1 || evidence.tmdbIds[0] !== String(film.tmdb)) return {ok: false, reason: 'tmdb_mismatch'};
    const norm = typeof LetterboxdMatch !== 'undefined' && LetterboxdMatch.normTitle ? LetterboxdMatch.normTitle : value => String(value || '').normalize('NFKC').toLowerCase().trim();
    if (!film.title || !evidence.title || norm(evidence.title) !== norm(film.title)) return {ok: false, reason: 'title_mismatch'};
    const year = evidence.years && evidence.years[0];
    if (film.year && year && Math.abs(Number(year) - Number(film.year)) > 1) return {ok: false, reason: 'year_mismatch'};
    return {ok: true};
  }
  // One verified film. The first continuation reads the film page. The next one localizes that same film. Neither is cron.
  async function enrichOne(env, sha, code, fetchImpl) {
    const key = CANDIDATES(sha);
    const opened = await readDoc(env, key);
    if (!opened.value) return {error: 'not_eligible'};
    const item = opened.value.candidates[code];
    if (!item || item.state !== 'verified' || !item.tmdb) return {pending: true, fetched: false, verified: false, code, state: 'needs_review', reason: 'not_verified', phase: 'enrich'};
    const filmId = 'tmdb_' + item.tmdb;
    const admissions = await readDoc(env, ADMISSIONS);
    if (admissions.value === undefined) return {error: 'storage_unavailable'};
    const film = admissions.value && admissions.value.films && admissions.value.films[filmId];
    if (!film || film.sourceCode !== code) return {pending: true, fetched: false, verified: false, code, state: 'needs_review', reason: 'admission_missing', phase: 'enrich'};
    if (!film.metadataAt) {
      if (!film.filmPath || !LetterboxdIdentity.isFilmPage(new URL('https://letterboxd.com' + film.filmPath))) {
        const stopped = {reason: 'film_path_missing', code, at: new Date().toISOString(), phase: 'enrich'};
        const parked = await park(env, key, opened.value, stopped);
        return {pending: true, fetched: false, verified: false, enriched: false, writes: parked.changed === true, persisted: parked.changed ? 'stop' : 'none', stop: stopped, code, phase: 'enrich'};
      }
      const fetched = await boundedFetch(fetchImpl, 'https://letterboxd.com' + film.filmPath, {redirect: 'manual', headers: {Accept: 'text/html'}}, PAGE_MS, PAGE_BYTES);
      if (fetched.stop) {
        const stopped = {reason: fetched.stop, code, at: new Date().toISOString(), phase: 'enrich'};
        const parked = await park(env, key, opened.value, stopped);
        return {pending: true, fetched: false, verified: false, enriched: false, writes: parked.changed === true, persisted: parked.changed ? 'stop' : 'none', stop: stopped, code, phase: 'enrich'};
      }
      const status = fetched.response.status;
      const transport = LetterboxdIdentity.transportStop(status, fetched.response.headers, fetched.text);
      if (transport || status !== 200) {
        const stopped = {reason: transport || 'fetch_failed', code, at: new Date().toISOString(), phase: 'enrich'};
        const parked = await park(env, key, opened.value, stopped);
        return {pending: true, fetched: status === 200, verified: false, enriched: false, writes: parked.changed === true, persisted: parked.changed ? 'stop' : 'none', stop: stopped, code, phase: 'enrich'};
      }
      let parsed;
      try {parsed = letterboxdPageTools().parseFilm(fetched.text, {id: filmId, title: film.title, original: film.title, year: film.year, tmdbId: film.tmdb, url: 'https://letterboxd.com' + film.filmPath});}
      catch {
        const marked = await markEnrichment(env, key, code, 'pending', {sha, item});
        if (marked.refused) return claimChanged(code, false);
        return {pending: true, fetched: true, verified: false, enriched: false, writes: marked.changed === true, persisted: marked.changed ? 'enrichment' : 'none', code, state: 'verified', reason: 'metadata_unparsed', phase: 'enrich'};
      }
      const agreed = enrichmentAgrees(fetched.text, film, code, sha, item);
      if (!agreed.ok) {
        const stopped = {reason: agreed.reason, code, at: new Date().toISOString(), phase: 'enrich'};
        const parked = await park(env, key, opened.value, stopped);
        return {pending: true, fetched: true, verified: false, enriched: false, writes: parked.changed === true, persisted: parked.changed ? 'stop' : 'none', stop: stopped, code, phase: 'enrich'};
      }
      if (!(await candidateBound(env, key, sha, code, film))) return claimChanged(code, false);
      const stored = await storeMetadata(env, filmId, parsed, film.filmPath, film);
      if (stored.refused) {
        const stopped = {reason: 'admission_changed', code, at: new Date().toISOString(), phase: 'enrich'};
        const parked = await park(env, key, opened.value, stopped);
        return {pending: true, fetched: true, verified: false, enriched: false, writes: parked.changed === true, persisted: parked.changed ? 'stop' : 'none', stop: stopped, code, phase: 'enrich'};
      }
      const marked = await markEnrichment(env, key, code, 'metadata', {sha, item});
      if (marked.refused) return claimChanged(code, stored.changed === true);
      const wrote = stored.changed === true || marked.changed === true;
      return {pending: true, fetched: true, verified: false, enriched: true, writes: wrote, persisted: wrote ? 'enrichment' : 'none', code, tmdb: item.tmdb, filmId, phase: 'enrich', state: 'enriched'};
    }
    if (!(await candidateBound(env, key, sha, code, film))) return claimChanged(code, false);
    const base = {id: filmId, title: film.title, original: film.title, year: film.year, tmdbId: film.tmdb, url: film.url, directors: film.directors || [], actors: film.actors || []};
    const titles = {};
    const people = {};
    // AIR-604: the Wikidata scope of the shared cooldown. The coordinator lives outside the try so that a skip is seen after the calls.
    const wikidata = typeof UpstreamCooldown === 'undefined' ? null : UpstreamCooldown.createCoordinator(env, {caller: 'archive-enrich'});
    try {
      if (typeof localizeFilmTitles === 'function') await localizeFilmTitles([base], titles, 'off', wikidata);
      if (typeof localizePeople === 'function') await localizePeople([base], people, 'off', wikidata);
    } catch {
      const stopped = {reason: 'localization_unavailable', code, at: new Date().toISOString(), phase: 'enrich', part: 'localization'};
      const parked = await park(env, key, opened.value, stopped);
      return {pending: true, fetched: true, verified: false, enriched: false, writes: parked.changed === true, persisted: parked.changed ? 'stop' : 'none', stop: stopped, code, phase: 'enrich'};
    }
    // A skipped Wikidata request means the localization is INCOMPLETE, not done: it is not stored and the enrichment is not marked `done`. The step parks with the transport-like reason
    // `upstream_cooldown` (no failure charged, no attempt) and resumes when the cooldown has expired; what the local cache could answer is not stored as the final localization.
    if (wikidata && wikidata.stats.skipped > 0) {
      const stopped = {reason: 'upstream_cooldown', code, at: new Date().toISOString(), phase: 'enrich', part: 'localization'};
      const parked = await park(env, key, opened.value, stopped);
      return {pending: true, fetched: true, verified: false, enriched: false, writes: parked.changed === true, persisted: parked.changed ? 'stop' : 'none', stop: stopped, code, phase: 'enrich'};
    }
    if (!(await candidateBound(env, key, sha, code, film))) return claimChanged(code, false);
    const localized = await storeLocalization(env, filmId, base, titles, film);
    if (localized.refused) {
      const stopped = {reason: 'admission_changed', code, at: new Date().toISOString(), phase: 'enrich', part: 'localization'};
      const parked = await park(env, key, opened.value, stopped);
      return {pending: true, fetched: true, verified: false, enriched: false, writes: parked.changed === true, persisted: parked.changed ? 'stop' : 'none', stop: stopped, code, phase: 'enrich'};
    }
    const marked = await markEnrichment(env, key, code, 'done', {sha, item});
    if (marked.refused) return claimChanged(code, localized.changed === true);
    const after = await readDoc(env, key);
    const next = LetterboxdRatedAdmission.resumePending(after.value && after.value.checkpoint, after.value && after.value.candidates);
    const wrote = localized.changed === true || marked.changed === true;
    return {pending: !!next.next, fetched: true, verified: false, enriched: true, writes: wrote, persisted: wrote ? 'enrichment' : 'none', code, tmdb: item.tmdb, filmId, phase: 'enrich', state: 'enriched'};
  }
  // The candidate row the page was proven against. A row that left `verified`, or now names another TMDB id or film path, is not advanced.
  // Latest candidate row against the persisted admission, read just before a write (AIR-354). R2 has no cross-document transaction;
  // the per-document CAS fences below remain, and a change after this read is reported by them as partial persistence, not hidden.
  async function candidateBound(env, key, sha, code, film) {
    const latest = await readDoc(env, key);
    const doc = latest.value;
    const row = doc && doc.candidates && doc.candidates[code];
    return !!row && doc.archiveSha256 === sha && row.state === 'verified' && String(row.tmdb) === String(film.tmdb) && row.filmPath === film.filmPath && film.sourceCode === code && film.archiveSha256 === sha;
  }
  function claimChanged(code, wrote) {
    return {pending: true, fetched: true, verified: false, enriched: false, writes: wrote === true, persisted: wrote ? 'enrichment' : 'none', code, state: 'needs_review', reason: 'claim_changed', phase: 'enrich'};
  }
  async function markEnrichment(env, key, code, enrichment, guard) {
    let refused = false;
    const saved = await casDoc(env, key, null, current => {
      refused = false;
      const row = current.candidates[code];
      if (guard && (!row || row.state !== 'verified' || current.archiveSha256 !== guard.sha || String(row.tmdb) !== String(guard.item.tmdb) || row.filmPath !== guard.item.filmPath)) {refused = true; return null;}
      if (row) current.candidates[code] = {...row, enrichment};
      const stopped = current.checkpoint && current.checkpoint.stopped;
      // Only this code's own stop is cleared; another code's stop stays.
      current.checkpoint = {...(current.checkpoint || {}), cursor: code, stopped: stopped && stopped.code && stopped.code !== code ? stopped : null};
      return current;
    });
    return {...saved, refused};
  }

  async function retryCandidates(env, {sha, codes, expected}) {
    if (!HEX64.test(String(sha || ''))) return {error: 'invalid_request'};
    const key = CANDIDATES(sha);
    const opened = await readDoc(env, key);
    if (opened.value === undefined) throw new Error('storage_unavailable');
    if (!opened.value) return {error: 'not_eligible'};
    const plan = LetterboxdRatedAdmission.planIdentityRetry(opened.value, {codes, expected});
    if (!plan.ok) return {error: plan.refusal, outcomes: plan.outcomes || []};
    if (!plan.requeue.length) return {replay: plan.outcomes.every(entry => entry.outcome === 'already_applied'), outcomes: plan.outcomes, changed: false, etag: opened.etag};
    const now = new Date().toISOString();
    const saved = await casDoc(env, key, opened.value, current => {
      if (current.archiveSha256 !== sha) return null;
      const live = LetterboxdRatedAdmission.planIdentityRetry(current, {codes, expected});
      if (!live.ok || !live.requeue.length) return null;
      for (const code of live.requeue) {
        const row = current.candidates[code];
        current.candidates[code] = {
          ...row, state: 'pending', reason: null, reasons: null, reasonKind: null,
          previousReason: row.reason, retryOf: row.reason, retriedAt: now,
        };
      }
      return current;
    });
    const after = saved.changed ? {value: saved.value, etag: opened.etag} : await readDoc(env, key);
    const outcomes = [];
    for (const entry of plan.outcomes) {
      if (entry.outcome !== 'written') {outcomes.push(entry); continue;}
      const row = after.value && after.value.candidates && after.value.candidates[entry.id];
      outcomes.push(row && row.state === 'pending' && row.retryOf ? entry : {id: entry.id, outcome: 'skipped_changed'});
    }
    return {replay: false, outcomes, changed: saved.changed === true, etag: after.etag};
  }

  // One pending code, or one enrichment continuation. A stop is stored and the next code is not fetched.
  // `code` selects that one pending or admitting row and does not walk the rest of the queue.
  // `lidOnlyRules` (AIR-673, tests and the owner's step 8 only): the H1 page rules of the dormant lid-only branch; omitted, the shipped EMPTY rules apply and no page can prove a lid-only Film.
  async function identityStep(env, {sha, resume = false, code: requested = null, fetchImpl: baseFetch = fetch, lidOnlyRules = undefined} = {}) {
    const fetchImpl = typeof UpstreamCooldown === 'undefined' || baseFetch.coordinator ? baseFetch : UpstreamCooldown.createCoordinator(env, {caller: 'letterboxd-archive-step'}).guard(baseFetch);
    if (!HEX64.test(String(sha || ''))) return {error: 'invalid_request'};
    // AIR-602 / ADR 0207 decision 1: under `closed` (and while the marker cannot be read) the identity and enrichment steps refuse BEFORE their first effect, so no page is fetched and nothing is stored.
    // At `d1` the step is the new path (ADR 0207 decisions 2 to 6); at `r2` it is the delivered legacy step.
    let atD1 = false;
    if (typeof LetterboxdAdmissionAuthority !== 'undefined') {
      let admission;
      try { admission = await LetterboxdAdmissionAuthority.admissionRouteNow(env); } catch { return {error: 'admission_unavailable'}; }
      if (admission.route === 'closed') return {error: 'admission_closed'};
      atD1 = admission.route === 'd1' && typeof LetterboxdAdmissionD1 !== 'undefined';
    }
    const key = CANDIDATES(sha);
    const opened = await readDoc(env, key);
    if (opened.value === undefined) return {error: 'storage_unavailable'};
    if (!opened.value) return {error: 'not_eligible'};
    const doc = opened.value;
    if (doc.checkpoint?.stopped && !resume) return withWrites({pending: true, fetched: false, stop: doc.checkpoint.stopped, code: doc.checkpoint.stopped.code || null, phase: doc.checkpoint.stopped.phase || 'identity'}, false, 'none');
    let code, item, phase;
    if (requested) {
      if (!/^[A-Za-z0-9]{1,16}$/.test(requested)) return {error: 'invalid_request'};
      item = doc.candidates[requested];
      if (!item || item.state === 'removed' || item.state === 'needs_review') return {error: 'not_eligible'};
      code = requested;
      phase = item.state === 'verified' ? 'enrich' : 'identity';
    } else {
      const checkpoint = resume ? {cursor: doc.checkpoint?.cursor || null, stopped: null} : doc.checkpoint;
      const view = LetterboxdRatedAdmission.resumePending(checkpoint, doc.candidates);
      if (!view.next) return withWrites({pending: false, fetched: false, stop: null, remaining: 0, phase: null}, false, 'none');
      code = view.next;
      item = doc.candidates[code];
      phase = view.phase;
    }
    let clearedStop = false;
    if (resume && doc.checkpoint?.stopped) {
      const cleared = await casDoc(env, key, doc, current => {current.checkpoint = {...(current.checkpoint || {}), stopped: null}; return current;});
      clearedStop = cleared.changed === true;
    }
    // AIR-602 / ADR 0207 decision 6 (G3): at `d1` the rated step ends at the verified admission and the tmdb-only rating. Enrichment (W5, W6) no longer writes the R2 entry (the catalog enrichment producer of
    // ADR 0211 owns it); a verified row still waiting for it is settled as done WITHOUT a page request and without any R2 write.
    if (phase === 'enrich' && atD1) {
      const settled = await markEnrichment(env, key, code, 'done', {sha, item});
      return withWrites({pending: true, fetched: false, verified: false, enriched: false, code, state: 'verified', reason: settled.refused ? 'claim_changed' : 'enrichment_retired', phase: 'enrich'}, settled.changed === true, settled.changed ? 'enrichment' : 'none');
    }
    if (phase === 'enrich') {
      const enriched = await enrichOne(env, sha, code, fetchImpl);
      return withWrites(enriched, enriched.writes === true, enriched.persisted || 'none');
    }
    // AIR-602 / ADR 0207 decision 4 (4A), review of PR #1018: at `d1` a recovering `admitting` row is NEVER admitted from its stored intent. The operation key is reconciled first: an applied attempt that matches the
    // intent finishes the row WITHOUT a fetch and without fresh evidence (the admission is already proven); a live attempt waits (the row stays `admitting`); otherwise both sources are really reacquired below
    // (the same bounded check a pending row gets) and compared with the intent, and only a check that was made can write evidence.
    let recoverGuard = null;
    const lidOnlyRow = atD1 && item.state === 'admitting' && item.kind === 'lid_only' && item.intendedTmdb == null;
    const recovering = atD1 && item.state === 'admitting' && (!!item.intendedTmdb || lidOnlyRow);
    // A recovering LID-only row's early dispositions (terminal review, retry charge, source change) rest on the ORIGINAL row read here: they write only while the current row still equals it (a replaced row is `claim_changed`).
    const originalClaim = lidOnlyRow ? {original: item} : undefined;
    // PR #1018 review: EVERY row that can reach a terminal decision at `d1` reconciles the key first (a pending row too), so each terminal write below carries the history assertion of the history it observed.
    if (atD1 && (recovering || item.state === 'pending')) {
      // AIR-673: a recovering lid-only row reconciles the SAME common key through the `lid_only` kind (its intent carries no movie).
      const settled = await (lidOnlyRow
        ? LetterboxdAdmissionD1.admitVerifiedLidOnly(env, {lid: code, route: 'letterboxd_rated_archive', settleOnly: true, intent: {proofDigest: item.proofDigest}, now: () => new Date().toISOString()})
        : LetterboxdAdmissionD1.admitVerifiedFilm(env, {kind: 'lid', lid: code, intent: recovering ? {tmdb: item.intendedTmdb} : null, evidenceDue: recovering && item.evidenceDue === true, settleOnly: true, pendingEvidence: recovering ? item.pendingEvidence || null : null, now: () => new Date().toISOString()}))
        .catch(error => ({outcome: 'deferred', reason: error && error.code || 'admission_unavailable'}));
      if (recovering && settled.outcome === 'present' && settled.fromIntent) {
        const committed = await commitVerified(env, sha, code, item, item.intendedTmdb, {title: item.name, years: Number.isInteger(item.year) ? [item.year] : [], path: item.filmPath}, doc.generatedAt, atD1, {settled: true});
        return withWrites(committed, committed.verified === true || committed.state === 'needs_review', committed.verified ? 'admission' : committed.state === 'needs_review' ? 'review' : 'none');
      }
      // AIR-673: an applied lid-only attempt of this row finishes it WITHOUT a fetch: the Film is admitted already; only the lid-keyed facts and the verified row remain (both idempotent).
      if (lidOnlyRow && settled.outcome === 'present_lid_only' && settled.fromReceipt) {
        const committed = await finishLidOnlyFromReceipt(env, sha, code, item, doc.generatedAt, settled);
        return withWrites(committed, committed.verified === true || committed.state === 'needs_review', committed.verified ? 'admission' : committed.state === 'needs_review' ? 'review' : 'none');
      }
      if (settled.outcome !== 'needs_check') return withWrites({pending: true, fetched: false, verified: false, code, state: item.state, reason: settled.reason === 'evidence_unrecorded' ? 'evidence_unrecorded' : 'in_flight', phase: 'identity'}, false, 'none');
      recoverGuard = settled.guard || null;
    }
    if (item.state === 'admitting' && item.intendedTmdb && !atD1) {
      const committed = await commitVerified(env, sha, code, item, item.intendedTmdb, {title: item.name, years: Number.isInteger(item.year) ? [item.year] : [], path: item.filmPath}, doc.generatedAt, atD1);
      return withWrites(committed, committed.verified === true || committed.state === 'needs_review', committed.verified ? 'admission' : committed.state === 'needs_review' ? 'review' : 'none');
    }
    // A terminal review of this step: at `d1` ONE batch with the history assertion (`recoverGuard`); a moved history leaves the row as it was (never terminal on a superseded history). At r2 `recoverGuard` is null.
    const terminal = async (reason, fetched, extra) => {
      const review = await markReview(env, key, code, reason, originalClaim || null, extra, {guard: recoverGuard});
      if (originalClaim && !review.refused && !review.changed) return withWrites({pending: true, fetched, verified: false, code, state: item.state, reason: 'claim_changed', phase: 'identity'}, false, 'none');
      if (review.refused) return withWrites({pending: true, fetched, verified: false, code, state: item.state, reason: 'in_flight', phase: 'identity'}, false, 'none');
      return withWrites({pending: true, fetched, verified: false, code, state: 'needs_review', reason: review.reason, reasons: review.reasons, reasonKind: review.reasonKind, phase: 'identity'}, review.changed === true, review.changed ? 'review' : 'none');
    };
    const namesake = collisionQueue(doc, code, item, null);
    if (namesake.blocked) return terminal(namesake.blocked, false);
    const page = await follow(fetchImpl, code);
    if (page.stop) {
      const stopped = {reason: page.stop, code, at: new Date().toISOString(), phase: 'identity'};
      const parked = await park(env, key, doc, stopped);
      return withWrites({pending: true, fetched: false, stop: stopped, code, verified: false, phase: 'identity'}, parked.changed === true, parked.changed ? 'stop' : 'none');
    }
    if (page.review && recovering) {
      const kept = await retryAdmitting(env, key, code, page.review, recoverGuard, lidOnlyRow ? item : null);
      return withWrites(kept, kept.writes === true, kept.writes ? 'review' : 'none');
    }
    if (page.review) return terminal(page.review, true);
    const evidence = LetterboxdIdentity.pageEvidence(page.html, page.landing, letterboxdPageTools());
    if (evidence && evidence.kind === 'page') evidence.redirectCode = code;
    const imported = await ownedMovieIds(env, doc, code, atD1);
    const queued = collisionQueue(doc, code, item, evidence);
    if (queued.blocked) return terminal(queued.blocked, true);
    const decision = LetterboxdIdentity.decide(queued.queue, queued.observations, {importedTmdb: imported})[queued.queue.length - 1];
    // AIR-673 / ADR 0217 (dormant): a page that names no accepted movie is tried as an H1 lid-only page. `H1_RULES` ships empty, so until the owner's step 8 no page proves `tmdb_none` and this branch changes nothing.
    if (atD1 && typeof LetterboxdLidOnlyProof !== 'undefined' && (!decision || decision.decision !== 'accepted' || !decision.tmdbId)) {
      const proof = await LetterboxdLidOnlyProof.lidOnlyPageProof({lid: code, redirect: page.redirect, fetched: page, evidence, ...(lidOnlyRules ? {rules: lidOnlyRules} : {}), checkedAt: new Date().toISOString()});
      if (proof.admits === true) {
        const committed = await commitLidOnly(env, sha, code, item, proof, doc.generatedAt, {guard: recoverGuard});
        return withWrites(committed, committed.verified === true || committed.state === 'needs_review' || clearedStop, committed.verified ? 'admission' : committed.state === 'needs_review' ? 'review' : 'none');
      }
    }
    if (recovering && (!decision || decision.decision !== 'accepted' || !decision.tmdbId)) {
      const changed = await reviewBehindGuard(env, key, code, 'source_changed', recoverGuard, originalClaim);
      return withWrites(changed, changed.writes === true, changed.writes ? 'review' : 'none');
    }
    if (!decision || decision.decision !== 'accepted' || !decision.tmdbId) {
      const extra = decision && decision.reasons || [];
      const reason = extra[0] || (decision && decision.decision) || 'not_accepted';
      return terminal(reason, true, extra);
    }
    const detail = await movieDetail(env, decision.tmdbId, fetchImpl);
    if (detail.stop) {
      const stopped = {reason: detail.stop, code, at: new Date().toISOString(), phase: 'identity'};
      const parked = await park(env, key, doc, stopped);
      return withWrites({pending: true, fetched: true, verified: false, stop: stopped, code, phase: 'identity'}, parked.changed === true, parked.changed ? 'stop' : 'none');
    }
    const agree = detail.review ? {ok: false, reason: detail.review} : LetterboxdRatedAdmission.movieDetailAgrees(detail.detail, decision.tmdbId, evidence.title || item.name, (evidence.years && evidence.years[0]) || item.year);
    if (recovering && detail.review) {
      const kept = await retryAdmitting(env, key, code, detail.review, recoverGuard, lidOnlyRow ? item : null);
      return withWrites(kept, kept.writes === true, kept.writes ? 'review' : 'none');
    }
    if (recovering && !agree.ok) {
      const changed = await reviewBehindGuard(env, key, code, 'source_changed', recoverGuard, originalClaim);
      return withWrites(changed, changed.writes === true, changed.writes ? 'review' : 'none');
    }
    if (!agree.ok || (item.historicalTmdb && item.historicalTmdb !== String(decision.tmdbId))) {
      const reason = item.historicalTmdb && item.historicalTmdb !== String(decision.tmdbId) ? 'historical_alias_conflict' : agree.reason;
      return terminal(reason, true);
    }
    const committed = await commitVerified(env, sha, code, item, decision.tmdbId, evidence, doc.generatedAt, atD1, {guard: recoverGuard, intended: recovering ? String(item.intendedTmdb) : null, intendedPath: recovering ? item.filmPath : null});
    return withWrites(committed, committed.verified === true || committed.state === 'needs_review' || clearedStop, committed.verified ? 'admission' : committed.state === 'needs_review' ? 'review' : 'none');
  }

  function statusOf(doc) {
    if (!doc) return {present: false, pending: 0, admitting: 0, verified: 0, needsReview: 0, enrichmentPending: 0, stopped: null, next: null, phase: null, retryable: [], requeued: []};
    const view = LetterboxdRatedAdmission.resumePending(doc.checkpoint, doc.candidates);
    const counts = {pending: 0, admitting: 0, verified: 0, needs_review: 0};
    let enrichmentPending = 0;
    const retryable = [];
    // AIR-350: codes an owner retry returned to the queue, with their current state, so the page can offer one
    // addressed identity step per code and show what that code became. Read only; the stored row is the source.
    const requeued = [];
    for (const item of Object.values(doc.candidates || {})) {
      if (!item) continue;
      if (Object.prototype.hasOwnProperty.call(counts, item.state)) counts[item.state]++;
      if (item.state === 'verified' && item.enrichment !== 'done') enrichmentPending++;
      if (item.retryOf && item.code) {
        requeued.push({
          code: item.code, name: item.name || null, year: Number.isInteger(item.year) ? item.year : null,
          state: item.state || null, reason: item.reason || null, retryOf: item.retryOf, retriedAt: item.retriedAt || null,
          tmdb: item.state === 'verified' && item.tmdb ? String(item.tmdb) : null,
          filmId: item.state === 'verified' && item.tmdb ? 'tmdb_' + item.tmdb : null,
          enrichment: item.state === 'verified' ? (item.enrichment || null) : null,
        });
      }
      if (item.state === 'needs_review' && LetterboxdIdentity.isRetryableReason(item.reason)) {
        retryable.push({
          code: item.code, name: item.name || null, year: Number.isInteger(item.year) ? item.year : null, state: item.state, reason: item.reason,
          reasonKind: item.reasonKind || LetterboxdIdentity.reasonKind(item.reason),
          fingerprint: LetterboxdRatedAdmission.retryFingerprint(item),
          observedAt: item.observedAt || null, registeredAt: item.registeredAt || null,
        });
      }
    }
    const byCode = (a, b) => a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
    retryable.sort(byCode);
    requeued.sort(byCode);
    return {present: true, pending: counts.pending, admitting: counts.admitting, verified: counts.verified, needsReview: counts.needs_review, enrichmentPending, stopped: view.stopped, next: view.next, phase: view.phase, retryable, requeued};
  }

  return {CANDIDATES, ADMISSIONS, registerCandidates, retryCandidates, identityStep, readDoc, statusOf, PAGE_BYTES, DETAIL_BYTES, follow, movieDetail};
})();
