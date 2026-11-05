// Durable rated-only candidates for one confirmed Letterboxd archive (AIR-340).
// The document is archive state in R2, beside the import receipt. It is not a ratings document and not a Film.
// Nothing here runs from the cron. Preview does not call it. A short code is never written as a Letterboxd lid.
const LetterboxdRatedCandidates = (() => {
  const CANDIDATES = sha => 'letterboxd/imports/' + sha + '/rated-candidates.json';
  const ADMISSIONS = 'letterboxd/admissions/verified-films.json';
  const HEX64 = /^[0-9a-f]{64}$/;
  const PAGE_MS = 25000, PAGE_BYTES = 3000000, DETAIL_MS = 12000, DETAIL_BYTES = 1000000;
  const emptyDoc = (sha, generatedAt) => ({schemaVersion: 1, archiveSha256: sha, generatedAt, candidates: {}, checkpoint: {cursor: null, stopped: null}});

  async function readDoc(env, key) {
    try {
      const object = await env.BUCKET.get(key);
      if (!object) return {value: null, etag: null};
      return {value: await object.json(), etag: object.etag ?? null};
    } catch {return {value: undefined, etag: null};}
  }
  async function casDoc(env, key, empty, apply) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = await readDoc(env, key);
      if (current.value === undefined) throw new Error('storage_unavailable');
      const base = current.value || empty;
      const next = await apply(JSON.parse(JSON.stringify(base)));
      if (next == null) return {value: base, changed: false};
      const saved = await env.BUCKET.put(key, JSON.stringify(next), {httpMetadata: {contentType: 'application/json'}, onlyIf: current.etag ? {etagMatches: current.etag} : {etagDoesNotMatch: '*'}});
      if (saved !== null) return {value: next, changed: true};
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

  async function rollbackCandidates(env, sha, codes) {
    const key = CANDIDATES(sha);
    const removed = [];
    const result = await casDoc(env, key, emptyDoc(sha, null), current => {
      if (!current || current.archiveSha256 !== sha) return null;
      let changed = false;
      for (const code of codes) {
        const item = current.candidates[code];
        if (!item || item.state === 'verified' || item.state === 'removed' || item.state === 'admitting') continue;
        item.state = 'removed';
        item.removedAt = new Date().toISOString();
        removed.push(code);
        changed = true;
      }
      return changed ? current : null;
    });
    return {removed, document: result.value};
  }

  function titleKey(name, year) {
    const norm = typeof LetterboxdMatch !== 'undefined' && LetterboxdMatch.normTitle ? LetterboxdMatch.normTitle(name) : String(name || '').normalize('NFKC').toLowerCase().trim();
    return norm + '|' + (year ?? '');
  }

  async function ownedMovieIds(env, doc, code) {
    const ids = new Set();
    const admissions = await readDoc(env, ADMISSIONS);
    if (admissions.value === undefined) throw new Error('storage_unavailable');
    for (const film of Object.values((admissions.value && admissions.value.films) || {})) {
      if (film && film.tmdb && film.sourceCode !== code) ids.add(String(film.tmdb));
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
    const name = error && error.name;
    if (name === 'TimeoutError' || name === 'AbortError') return {stop: 'timeout'};
    return {stop: 'fetch_failed'};
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
    const read = await readBounded(response, limit);
    if (read.oversize) return {stop: 'oversized'};
    if (read.error) return stopFrom(read.error);
    return {response, text: read.text || ''};
  }

  async function follow(fetchImpl, code) {
    let url = 'https://boxd.it/' + code;
    for (let hop = 0; hop < 4; hop++) {
      const fetched = await boundedFetch(fetchImpl, url, {redirect: 'manual', headers: {Accept: 'text/html'}}, PAGE_MS, PAGE_BYTES);
      if (fetched.stop) return {stop: fetched.stop};
      const response = fetched.response;
      const status = response.status;
      const headers = response.headers;
      if (status >= 300 && status < 400) {
        const stop = LetterboxdIdentity.transportStop(status, headers, '');
        if (stop) return {stop};
        const next = LetterboxdIdentity.allowedHop(headers.get('location'), url);
        if (!next) return {review: 'blocked_redirect'};
        url = next.toString();
        continue;
      }
      const html = fetched.text;
      const stop = LetterboxdIdentity.transportStop(status, headers, html);
      if (stop) return {stop};
      if (status !== 200) return {review: 'fetch_failed'};
      const landing = new URL(url);
      if (!LetterboxdIdentity.isFilmPage(landing)) return {review: 'not_film_page'};
      return {html, landing};
    }
    return {review: 'too_many_hops'};
  }

  async function movieDetail(env, tmdb, fetchImpl) {
    if (!env || !env.TMDB_API_READ_ACCESS_TOKEN) return {stop: 'tmdb_unavailable'};
    const fetched = await boundedFetch(fetchImpl, 'https://api.themoviedb.org/3/movie/' + encodeURIComponent(tmdb) + '?language=en-US', {headers: {Authorization: 'Bearer ' + env.TMDB_API_READ_ACCESS_TOKEN, Accept: 'application/json'}}, DETAIL_MS, DETAIL_BYTES);
    if (fetched.stop) return {stop: fetched.stop};
    const body = fetched.text;
    const stop = LetterboxdIdentity.transportStop(fetched.response.status, fetched.response.headers, body);
    if (stop) return {stop};
    if (fetched.response.status !== 200) return {review: 'tmdb_fetch_failed'};
    try {return {detail: JSON.parse(body)};} catch {return {review: 'tmdb_fetch_failed'};}
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
  async function markReview(env, key, code, reason, claim, extra) {
    const payload = reviewReasons(reason, extra);
    const saved = await casDoc(env, key, null, current => {
      const row = current.candidates[code];
      if (!row || row.state === 'verified' || row.state === 'removed') return null;
      if (claim && !sameClaim(row, claim.tmdb, claim.filmPath)) return null;
      current.candidates[code] = {...row, state: 'needs_review', reason: payload.reason, reasons: payload.reasons, reasonKind: payload.reasonKind, intendedTmdb: null};
      current.checkpoint = {...(current.checkpoint || {}), cursor: code, stopped: null};
      return current;
    });
    return {...payload, changed: saved.changed === true};
  }
  async function park(env, key, doc, stopped) {
    return casDoc(env, key, doc, current => {current.checkpoint = {...(current.checkpoint || {}), stopped}; return current;});
  }

  function refusedClaim(code, outcome) {
    const state = outcome === 'intent_conflict' ? 'admitting' : outcome === 'verified_conflict' || outcome === 'already' ? 'verified' : outcome === 'removed' || outcome === 'needs_review' ? outcome : 'pending';
    return {pending: true, fetched: true, verified: false, code, state, reason: outcome, phase: 'identity'};
  }
  // Fence the intended movie, read it back, then admit that one source code and only then write the rating.
  // A removed, reviewed or differently claimed row is not admitted and is not marked verified.
  async function commitVerified(env, sha, code, item, tmdb, evidence, generatedAt) {
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
        outcome = row.intendedTmdb === String(tmdb) && row.filmPath === film.filmPath ? 'held' : 'intent_conflict';
        return null;
      }
      if (row.state !== 'pending') {outcome = 'claim_changed'; return null;}
      current.candidates[code] = {...row, state: 'admitting', intendedTmdb: String(tmdb), filmPath: film.filmPath, enrichment: 'pending', reason: null};
      current.checkpoint = {...(current.checkpoint || {}), cursor: code, stopped: null};
      outcome = 'claimed';
      return current;
    });
    if (outcome === 'already') return {pending: true, fetched: true, verified: true, code, tmdb: String(tmdb), filmId: film.filmId, phase: 'identity'};
    if (outcome !== 'claimed' && outcome !== 'held') return refusedClaim(code, outcome);
    const held = await readClaim(env, key, code, tmdb, film.filmPath);
    if (!held.ok) return refusedClaim(code, held.reason);
    const admitted = await writeAdmission(env, film);
    if (!admitted.ok) {
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
      current.candidates[code] = {...row, state: 'verified', tmdb: String(tmdb), filmPath: film.filmPath, enrichment: row.enrichment || 'pending', intendedTmdb: null, reason: null};
      current.checkpoint = {...(current.checkpoint || {}), cursor: code, stopped: null};
      return current;
    });
    const after = await readDoc(env, key);
    const row = after.value && after.value.candidates && after.value.candidates[code];
    if (!row || row.state !== 'verified' || row.tmdb !== String(tmdb) || row.filmPath !== film.filmPath) return refusedClaim(code, 'claim_changed');
    return {pending: true, fetched: true, verified: true, code, tmdb: String(tmdb), rating: rating.outcomes, filmId: film.filmId, phase: 'identity'};
  }

  function peopleOf(list) {
    return (Array.isArray(list) ? list : []).filter(person => person && typeof person.id === 'string').slice(0, 10).map(person => ({id: person.id, original: person.original || person.name || null, name: person.name || person.original || null}));
  }
  async function storeMetadata(env, filmId, parsed, filmPath) {
    return casDoc(env, ADMISSIONS, {schemaVersion: 1, films: {}}, current => {
      const prior = current.films[filmId];
      if (!prior) return null;
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
  }
  async function storeLocalization(env, filmId, film, titles) {
    const cached = titles[film.id];
    return casDoc(env, ADMISSIONS, {schemaVersion: 1, films: {}}, current => {
      const prior = current.films[filmId];
      if (!prior) return null;
      if (cached && cached.title) {prior.titleRu = cached.title; prior.titleStatus = cached.status || 'provisional';}
      prior.directors = peopleOf(film.directors);
      prior.actors = peopleOf(film.actors);
      prior.peopleNamesVersion = 2;
      prior.peopleLocalizedAt = new Date().toISOString();
      return current;
    });
  }

  function enrichmentAgrees(html, film, code) {
    let evidence;
    try {evidence = LetterboxdIdentity.pageEvidence(html, new URL('https://letterboxd.com' + film.filmPath), letterboxdPageTools());}
    catch {return {ok: false, reason: 'metadata_unparsed'};}
    if (!evidence || evidence.kind !== 'page') return {ok: false, reason: 'metadata_unparsed'};
    if (evidence.path !== film.filmPath) return {ok: false, reason: 'path_mismatch'};
    if (!evidence.shortlinkPresent || evidence.shortCode !== code) return {ok: false, reason: 'shortlink_mismatch'};
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
        const marked = await markEnrichment(env, key, code, 'pending');
        return {pending: true, fetched: true, verified: false, enriched: false, writes: marked.changed === true, persisted: marked.changed ? 'enrichment' : 'none', code, state: 'verified', reason: 'metadata_unparsed', phase: 'enrich'};
      }
      const agreed = enrichmentAgrees(fetched.text, film, code);
      if (!agreed.ok) {
        const stopped = {reason: agreed.reason, code, at: new Date().toISOString(), phase: 'enrich'};
        const parked = await park(env, key, opened.value, stopped);
        return {pending: true, fetched: true, verified: false, enriched: false, writes: parked.changed === true, persisted: parked.changed ? 'stop' : 'none', stop: stopped, code, phase: 'enrich'};
      }
      const stored = await storeMetadata(env, filmId, parsed, film.filmPath);
      const marked = await markEnrichment(env, key, code, 'metadata');
      const wrote = stored.changed === true || marked.changed === true;
      return {pending: true, fetched: true, verified: false, enriched: true, writes: wrote, persisted: wrote ? 'enrichment' : 'none', code, tmdb: item.tmdb, filmId, phase: 'enrich', state: 'enriched'};
    }
    const base = {id: filmId, title: film.title, original: film.title, year: film.year, tmdbId: film.tmdb, url: film.url, directors: film.directors || [], actors: film.actors || []};
    const titles = {};
    const people = {};
    try {
      if (typeof localizeFilmTitles === 'function') await localizeFilmTitles([base], titles, 'off');
      if (typeof localizePeople === 'function') await localizePeople([base], people, 'off');
    } catch {
      const stopped = {reason: 'localization_unavailable', code, at: new Date().toISOString(), phase: 'enrich'};
      const parked = await park(env, key, opened.value, stopped);
      return {pending: true, fetched: true, verified: false, enriched: false, writes: parked.changed === true, persisted: parked.changed ? 'stop' : 'none', stop: stopped, code, phase: 'enrich'};
    }
    const localized = await storeLocalization(env, filmId, base, titles);
    const marked = await markEnrichment(env, key, code, 'done');
    const after = await readDoc(env, key);
    const next = LetterboxdRatedAdmission.resumePending(after.value && after.value.checkpoint, after.value && after.value.candidates);
    const wrote = localized.changed === true || marked.changed === true;
    return {pending: !!next.next, fetched: true, verified: false, enriched: true, writes: wrote, persisted: wrote ? 'enrichment' : 'none', code, tmdb: item.tmdb, filmId, phase: 'enrich', state: 'enriched'};
  }
  async function markEnrichment(env, key, code, enrichment) {
    return casDoc(env, key, null, current => {
      if (current.candidates[code]) current.candidates[code] = {...current.candidates[code], enrichment};
      current.checkpoint = {...(current.checkpoint || {}), cursor: code, stopped: null};
      return current;
    });
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
  async function identityStep(env, {sha, resume = false, code: requested = null, fetchImpl = fetch} = {}) {
    if (!HEX64.test(String(sha || ''))) return {error: 'invalid_request'};
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
    if (phase === 'enrich') {
      const enriched = await enrichOne(env, sha, code, fetchImpl);
      return withWrites(enriched, enriched.writes === true, enriched.persisted || 'none');
    }
    if (item.state === 'admitting' && item.intendedTmdb) {
      const committed = await commitVerified(env, sha, code, item, item.intendedTmdb, {title: item.name, years: Number.isInteger(item.year) ? [item.year] : [], path: item.filmPath}, doc.generatedAt);
      return withWrites(committed, committed.verified === true || committed.state === 'needs_review', committed.verified ? 'admission' : committed.state === 'needs_review' ? 'review' : 'none');
    }
    const namesake = collisionQueue(doc, code, item, null);
    if (namesake.blocked) {
      const review = await markReview(env, key, code, namesake.blocked);
      return withWrites({pending: true, fetched: false, verified: false, code, state: 'needs_review', reason: review.reason, reasons: review.reasons, reasonKind: review.reasonKind, phase: 'identity'}, review.changed === true, review.changed ? 'review' : 'none');
    }
    const page = await follow(fetchImpl, code);
    if (page.stop) {
      const stopped = {reason: page.stop, code, at: new Date().toISOString(), phase: 'identity'};
      const parked = await park(env, key, doc, stopped);
      return withWrites({pending: true, fetched: false, stop: stopped, code, verified: false, phase: 'identity'}, parked.changed === true, parked.changed ? 'stop' : 'none');
    }
    if (page.review) {
      const review = await markReview(env, key, code, page.review);
      return withWrites({pending: true, fetched: true, verified: false, code, state: 'needs_review', reason: review.reason, reasons: review.reasons, reasonKind: review.reasonKind, phase: 'identity'}, review.changed === true, review.changed ? 'review' : 'none');
    }
    const evidence = LetterboxdIdentity.pageEvidence(page.html, page.landing, letterboxdPageTools());
    if (evidence && evidence.kind === 'page') evidence.redirectCode = code;
    const imported = await ownedMovieIds(env, doc, code);
    const queued = collisionQueue(doc, code, item, evidence);
    if (queued.blocked) {
      const review = await markReview(env, key, code, queued.blocked);
      return withWrites({pending: true, fetched: true, verified: false, code, state: 'needs_review', reason: review.reason, reasons: review.reasons, reasonKind: review.reasonKind, phase: 'identity'}, review.changed === true, review.changed ? 'review' : 'none');
    }
    const decision = LetterboxdIdentity.decide(queued.queue, queued.observations, {importedTmdb: imported})[queued.queue.length - 1];
    if (!decision || decision.decision !== 'accepted' || !decision.tmdbId) {
      const extra = decision && decision.reasons || [];
      const reason = extra[0] || (decision && decision.decision) || 'not_accepted';
      const review = await markReview(env, key, code, reason, null, extra);
      return withWrites({pending: true, fetched: true, verified: false, code, state: 'needs_review', reason: review.reason, reasons: review.reasons, reasonKind: review.reasonKind, phase: 'identity'}, review.changed === true, review.changed ? 'review' : 'none');
    }
    const detail = await movieDetail(env, decision.tmdbId, fetchImpl);
    if (detail.stop) {
      const stopped = {reason: detail.stop, code, at: new Date().toISOString(), phase: 'identity'};
      const parked = await park(env, key, doc, stopped);
      return withWrites({pending: true, fetched: true, verified: false, stop: stopped, code, phase: 'identity'}, parked.changed === true, parked.changed ? 'stop' : 'none');
    }
    const agree = detail.review ? {ok: false, reason: detail.review} : LetterboxdRatedAdmission.movieDetailAgrees(detail.detail, decision.tmdbId, evidence.title || item.name, (evidence.years && evidence.years[0]) || item.year);
    if (!agree.ok || (item.historicalTmdb && item.historicalTmdb !== String(decision.tmdbId))) {
      const reason = item.historicalTmdb && item.historicalTmdb !== String(decision.tmdbId) ? 'historical_alias_conflict' : agree.reason;
      const review = await markReview(env, key, code, reason);
      return withWrites({pending: true, fetched: true, verified: false, code, state: 'needs_review', reason: review.reason, reasons: review.reasons, reasonKind: review.reasonKind, phase: 'identity'}, review.changed === true, review.changed ? 'review' : 'none');
    }
    const committed = await commitVerified(env, sha, code, item, decision.tmdbId, evidence, doc.generatedAt);
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

  return {CANDIDATES, ADMISSIONS, registerCandidates, rollbackCandidates, retryCandidates, identityStep, readDoc, statusOf, PAGE_BYTES, DETAIL_BYTES};
})();
