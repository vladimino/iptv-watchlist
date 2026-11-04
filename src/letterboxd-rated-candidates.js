// Durable rated-only candidates for one confirmed Letterboxd archive (AIR-340).
// The document is archive state in R2, beside the import receipt. It is not a ratings document and not a Film.
// Nothing here runs from the cron. Preview does not call it. A short code is never written as a Letterboxd lid.
const LetterboxdRatedCandidates = (() => {
  const CANDIDATES = sha => 'letterboxd/imports/' + sha + '/rated-candidates.json';
  const ADMISSIONS = 'letterboxd/admissions/verified-films.json';
  const HEX64 = /^[0-9a-f]{64}$/;
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
          chunk, registeredAt: new Date().toISOString(),
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
        if (!item || item.state === 'verified' || item.state === 'removed') continue;
        item.state = 'removed';
        item.removedAt = new Date().toISOString();
        removed.push(code);
        changed = true;
      }
      return changed ? current : null;
    });
    return {removed, document: result.value};
  }

  async function writeAdmission(env, film) {
    const result = await casDoc(env, ADMISSIONS, {schemaVersion: 1, films: {}}, current => {
      const prior = current.films[film.filmId];
      if (prior && prior.tmdb === film.tmdb && prior.sourceCode === film.sourceCode && prior.archiveSha256 === film.archiveSha256) return null;
      if (prior && prior.tmdb && prior.tmdb !== film.tmdb) return null;
      current.films[film.filmId] = {tmdb: film.tmdb, sourceCode: film.sourceCode, archiveSha256: film.archiveSha256, title: film.title || null, year: film.year, verifiedAt: new Date().toISOString()};
      return current;
    });
    const stored = result.value && result.value.films && result.value.films[film.filmId];
    if (stored && stored.tmdb !== film.tmdb) return {ok: false, reason: 'historical_alias_conflict'};
    return {ok: true, film: stored};
  }

  async function follow(fetchImpl, code) {
    let url = 'https://boxd.it/' + code;
    for (let hop = 0; hop < 4; hop++) {
      const response = await fetchImpl(url, {redirect: 'manual', headers: {Accept: 'text/html'}});
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
      const html = await response.text();
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
    const response = await fetchImpl('https://api.themoviedb.org/3/movie/' + encodeURIComponent(tmdb) + '?language=en-US', {headers: {Authorization: 'Bearer ' + env.TMDB_API_READ_ACCESS_TOKEN, Accept: 'application/json'}});
    const body = await response.text();
    const stop = LetterboxdIdentity.transportStop(response.status, response.headers, body);
    if (stop) return {stop};
    if (response.status !== 200) return {review: 'tmdb_fetch_failed'};
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

  // One pending code. A stop is stored and the next code is not fetched. resume clears a stored stop first.
  async function identityStep(env, {sha, resume = false, fetchImpl = fetch} = {}) {
    if (!HEX64.test(String(sha || ''))) return {error: 'invalid_request'};
    const key = CANDIDATES(sha);
    const opened = await readDoc(env, key);
    if (opened.value === undefined) return {error: 'storage_unavailable'};
    if (!opened.value) return {error: 'not_eligible'};
    const doc = opened.value;
    if (doc.checkpoint?.stopped && !resume) return {pending: true, fetched: false, stop: doc.checkpoint.stopped, code: doc.checkpoint.stopped.code || null};
    const view = LetterboxdRatedAdmission.resumePending(resume ? {cursor: doc.checkpoint?.cursor || null, stopped: null} : doc.checkpoint, doc.candidates);
    if (!view.next) return {pending: false, fetched: false, stop: null, remaining: view.pending.length};
    const code = view.next;
    const item = doc.candidates[code];
    if (resume && doc.checkpoint?.stopped) {
      await casDoc(env, key, doc, current => {current.checkpoint = {...(current.checkpoint || {}), stopped: null}; return current;});
    }
    const page = await follow(fetchImpl, code);
    if (page.stop) {
      const stopped = {reason: page.stop, code, at: new Date().toISOString()};
      await casDoc(env, key, doc, current => {current.checkpoint = {...(current.checkpoint || {}), stopped}; return current;});
      return {pending: true, fetched: false, stop: stopped, code, verified: false};
    }
    if (page.review) {
      await casDoc(env, key, doc, current => {
        if (current.candidates[code]) current.candidates[code] = {...current.candidates[code], state: 'needs_review', reason: page.review};
        current.checkpoint = {...(current.checkpoint || {}), cursor: code, stopped: null};
        return current;
      });
      return {pending: true, fetched: true, verified: false, code, state: 'needs_review', reason: page.review};
    }
    const evidence = LetterboxdIdentity.pageEvidence(page.html, page.landing, letterboxdPageTools());
    const entry = {code, group: 'unmatched', name: item.name || '', year: item.year ?? null, ledgerTmdbId: item.historicalTmdb || null};
    const decision = LetterboxdIdentity.decide([entry], new Map([[code, evidence]]), {importedTmdb: new Set()})[0];
    if (decision.decision !== 'accepted' || !decision.tmdbId) {
      const reason = (decision.reasons && decision.reasons[0]) || decision.decision;
      await casDoc(env, key, doc, current => {
        if (current.candidates[code]) current.candidates[code] = {...current.candidates[code], state: 'needs_review', reason};
        current.checkpoint = {...(current.checkpoint || {}), cursor: code, stopped: null};
        return current;
      });
      return {pending: true, fetched: true, verified: false, code, state: 'needs_review', reason};
    }
    const detail = await movieDetail(env, decision.tmdbId, fetchImpl);
    if (detail.stop) {
      const stopped = {reason: detail.stop, code, at: new Date().toISOString()};
      await casDoc(env, key, doc, current => {current.checkpoint = {...(current.checkpoint || {}), stopped}; return current;});
      return {pending: true, fetched: true, verified: false, stop: stopped, code};
    }
    const agree = detail.review ? {ok: false, reason: detail.review} : LetterboxdRatedAdmission.movieDetailAgrees(detail.detail, decision.tmdbId, evidence.title || item.name, (evidence.years && evidence.years[0]) || item.year);
    if (!agree.ok || (item.historicalTmdb && item.historicalTmdb !== String(decision.tmdbId))) {
      const reason = item.historicalTmdb && item.historicalTmdb !== String(decision.tmdbId) ? 'historical_alias_conflict' : agree.reason;
      await casDoc(env, key, doc, current => {
        if (current.candidates[code]) current.candidates[code] = {...current.candidates[code], state: 'needs_review', reason};
        current.checkpoint = {...(current.checkpoint || {}), cursor: code, stopped: null};
        return current;
      });
      return {pending: true, fetched: true, verified: false, code, state: 'needs_review', reason};
    }
    const rating = await writeRating(env, decision.tmdbId, item, doc.generatedAt, sha);
    const film = LetterboxdRatedAdmission.admissionFilm({tmdb: decision.tmdbId, sourceCode: code, archiveSha256: sha, title: evidence.title || item.name, year: (evidence.years && evidence.years[0]) || item.year});
    const admitted = await writeAdmission(env, film);
    if (!admitted.ok) {
      await casDoc(env, key, doc, current => {
        if (current.candidates[code]) current.candidates[code] = {...current.candidates[code], state: 'needs_review', reason: admitted.reason};
        current.checkpoint = {...(current.checkpoint || {}), cursor: code, stopped: null};
        return current;
      });
      return {pending: true, fetched: true, verified: false, code, state: 'needs_review', reason: admitted.reason};
    }
    await casDoc(env, key, doc, current => {
      if (current.candidates[code]) current.candidates[code] = {...current.candidates[code], state: 'verified', tmdb: String(decision.tmdbId), reason: null};
      current.checkpoint = {...(current.checkpoint || {}), cursor: code, stopped: null};
      return current;
    });
    return {pending: true, fetched: true, verified: true, code, tmdb: String(decision.tmdbId), rating: rating.outcomes, filmId: film.filmId};
  }

  return {CANDIDATES, ADMISSIONS, registerCandidates, rollbackCandidates, identityStep, readDoc};
})();
