// AIR-604 (card UC1; ADR 0211 decision 5, ADR 0207 decision 7): one shared, durable cooldown per upstream scope, adopted by every relevant caller.
// DORMANT: the mode row `upstream_coordination` is absent or `off` by default, and then this module reads nothing but that row and writes nothing, so every caller
// behaves exactly as before. It is NOT a request-rate limiter: no token bucket, no shared spacing; each caller keeps its own spacing and its own retry policy.
//
// A scope is a credential or rate-limit domain, never a producer: `tmdb`, `letterboxd` (letterboxd.com and boxd.it), `wikidata` (query.wikidata.org). A cooldown of one scope
// never blocks another scope.
//
// Signals that set a cooldown: a 429, a Cloudflare challenge, a 403. Signals that do NOT: a 404 (one entity), a 5xx, a timeout, a network error (one failing entity must not
// block the scope; they stay the caller's local retry). A skipped request costs the caller no attempt, failure or quarantine budget: the caller maps it to its own not-now path.
//
// Fail-safe (ADR 0211): an absent table, an unreadable mode row or a failed cooldown read means `off` for that call; a failed cooldown write is swallowed and the caller's
// local backoff still applies. Coordination never blocks production work and never makes a caller more aggressive than today.
//
// READ-ONLY CALLERS (the TMDB status probe) call `peek`, which never writes; only `after` writes, and only a writer path calls it.
// The module imports nothing: the Worker bundle scopes it as `UpstreamCooldown` (build.mjs), and a bundled caller cannot import. The challenge test is therefore a
// COPY of `isChallenge` in src/letterboxd-identity.js; tests/upstream-cooldown.mjs asserts the two agree on every shape.
export function isChallenge(status, headers, html = '') {
  if (String(headers?.get?.('cf-mitigated') ?? '').toLowerCase() === 'challenge') return true;
  if (status !== 200 && status !== 404 && /cf-chl|challenge-platform|just a moment\.\.\.|attention required|captcha/i.test(html)) return true;
  return status === 200 && /\/cdn-cgi\/challenge-platform\/|cf-chl-opt|<title>\s*just a moment/i.test(html);
}

export const SCOPES = Object.freeze(['tmdb', 'letterboxd', 'wikidata']);
export const MODES = Object.freeze(['off', 'observe', 'enforce']);
export const RETRY_AFTER_MIN_S = 30;
export const RETRY_AFTER_MAX_S = 3600;
export const DEFAULT_429_S = 300;
export const DEFAULT_BLOCK_S = 900;

const HOSTS = Object.freeze({
  'api.themoviedb.org': 'tmdb',
  'letterboxd.com': 'letterboxd',
  'www.letterboxd.com': 'letterboxd',
  'boxd.it': 'letterboxd',
  'query.wikidata.org': 'wikidata'
});

// The scope of a request URL, or null for a host outside the three scopes (EPG XMLTV, Telegram, webhooks, Access certs are out of scope).
export function scopeOfUrl(input) {
  let url;
  try {url = input instanceof URL ? input : new URL(String(input));} catch {return null;}
  if (url.protocol !== 'https:') return null;
  return HOSTS[url.hostname] || null;
}

// Retry-After as seconds: a non-negative integer of seconds or an HTTP date. Anything else is absent.
export function parseRetryAfter(value, now = Date.now()) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (/^\d{1,9}$/.test(text)) return Number(text);
  const at = Date.parse(text);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.ceil((at - now) / 1000));
}

// The cooldown a response asks for, or null. headers: a Headers-like (get). html: the body text when the caller has it (challenge detection of a 200 page).
export function classifySignal({status, headers = null, html = ''}, now = Date.now()) {
  let reason = null;
  if (isChallenge(status, headers, html || '')) reason = 'challenge';
  else if (status === 403) reason = 'forbidden';
  else if (status === 429) reason = 'rate_limited';
  if (!reason) return null;
  const header = headers && typeof headers.get === 'function' ? headers.get('retry-after') : null;
  const asked = parseRetryAfter(header, now);
  const seconds = asked === null
    ? (reason === 'rate_limited' ? DEFAULT_429_S : DEFAULT_BLOCK_S)
    : Math.min(RETRY_AFTER_MAX_S, Math.max(RETRY_AFTER_MIN_S, asked));
  return {reason, seconds, retryAfter: asked};
}

const dbOf = env => (env && env.DB && typeof env.DB.prepare === 'function') ? env.DB : null;

// The mode of the durable row; an absent table, an absent row, an unknown value or any D1 error is `off`.
export async function readMode(env) {
  const db = dbOf(env);
  if (!db) return 'off';
  try {
    const row = await db.prepare('SELECT mode FROM upstream_coordination WHERE id = 1').first();
    return row && MODES.includes(row.mode) ? row.mode : 'off';
  } catch {return 'off';}
}

// The active cooldown of one scope, or null (absent table, absent row, expired row, unreadable state).
export async function readCooldown(env, scope, now = Date.now()) {
  const db = dbOf(env);
  if (!db || !SCOPES.includes(scope)) return null;
  try {
    const row = await db.prepare('SELECT until_at, reason, retry_after_s FROM upstream_cooldown WHERE scope = ?').bind(scope).first();
    if (!row || !(Number(row.until_at) > now)) return null;
    return {scope, until: Number(row.until_at), reason: row.reason, retryAfter: row.retry_after_s ?? null};
  } catch {return null;}
}

// The monotonic write: commutative, so concurrent writers never shorten a cooldown; the reason and Retry-After follow the latest until_at only.
export const WRITE_SQL = `INSERT INTO upstream_cooldown (scope, until_at, reason, retry_after_s, set_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
 ON CONFLICT(scope) DO UPDATE SET
  reason = CASE WHEN excluded.until_at > until_at THEN excluded.reason ELSE reason END,
  retry_after_s = CASE WHEN excluded.until_at > until_at THEN excluded.retry_after_s ELSE retry_after_s END,
  set_by = CASE WHEN excluded.until_at > until_at THEN excluded.set_by ELSE set_by END,
  until_at = MAX(until_at, excluded.until_at),
  updated_at = MAX(updated_at, excluded.updated_at)`;

export async function writeCooldown(env, scope, signal, setBy, now = Date.now()) {
  const db = dbOf(env);
  if (!db || !SCOPES.includes(scope) || !signal) return false;
  try {
    await db.prepare(WRITE_SQL).bind(scope, now + signal.seconds * 1000, signal.reason, signal.retryAfter, String(setBy || 'unknown').slice(0, 64), now).run();
    return true;
  } catch {return false;}
}

// Thrown by `fetch` when an enforced cooldown skips the request. The caller maps it to its own not-now path; it is never a failure of the entity.
export class UpstreamCooldownSkip extends Error {
  constructor(scope, until, reason) {
    super('upstream_cooldown');
    this.name = 'UpstreamCooldownSkip';
    this.code = 'upstream_cooldown';
    this.scope = scope;
    this.until = until;
    this.reason = reason;
  }
}

// One coordinator per caller run. The mode is read once per run (a mode change takes effect on the next run); the cooldown row is read before EACH request.
export function createCoordinator(env, {caller, now = () => Date.now()} = {}) {
  let modePromise = null;
  const mode = () => (modePromise ||= readMode(env));
  const stats = {skipped: 0, wouldSkip: 0, written: 0, writeFailed: 0};
  return {
    stats,
    mode,
    // Read-only: is the scope cooling? In `off` nothing but the mode row is read. In `observe` the decision is counted and nothing is skipped.
    async peek(scope) {
      const m = await mode();
      if (m === 'off') return {mode: m, skip: false, until: null, reason: null};
      const cooling = await readCooldown(env, scope, now());
      if (!cooling) return {mode: m, skip: false, until: null, reason: null};
      if (m === 'observe') {stats.wouldSkip++; return {mode: m, skip: false, wouldSkip: true, until: cooling.until, reason: cooling.reason};}
      stats.skipped++;
      return {mode: m, skip: true, until: cooling.until, reason: cooling.reason};
    },
    // Writer paths only: record the response of a request that WAS sent. A 404, a 5xx and a success write nothing.
    async after(scope, response) {
      const m = await mode();
      if (m === 'off' || !response) return null;
      const signal = classifySignal({status: response.status, headers: response.headers, html: response.html || ''}, now());
      if (!signal) return null;
      const ok = await writeCooldown(env, scope, signal, caller, now());
      if (ok) stats.written++; else stats.writeFailed++;
      return signal;
    },
    // For callers that read the body themselves (the bounded Letterboxd/TMDB fetches): a fetch that only PEEKS (a skip throws UpstreamCooldownSkip) and carries the coordinator,
    // so the caller records the response with `after` once it has the body (a challenge page is detected from the body). The write belongs to that caller.
    guard(fetchImpl) {
      const self = this;
      const guarded = async (url, init) => {
        const scope = scopeOfUrl(url);
        if (scope) {
          const gate = await self.peek(scope);
          if (gate.skip) throw new UpstreamCooldownSkip(scope, gate.until, gate.reason);
        }
        return fetchImpl(url, init);
      };
      guarded.coordinator = self;
      return guarded;
    },
    // A guarded fetch for a writer path. `fetchImpl` is the caller's own (tests inject one). A skip throws UpstreamCooldownSkip; nothing else changes about the response.
    async fetch(fetchImpl, url, init, {scope = scopeOfUrl(url)} = {}) {
      if (!scope) return fetchImpl(url, init);
      const gate = await this.peek(scope);
      if (gate.skip) throw new UpstreamCooldownSkip(scope, gate.until, gate.reason);
      const response = await fetchImpl(url, init);
      await this.after(scope, response);
      return response;
    }
  };
}
