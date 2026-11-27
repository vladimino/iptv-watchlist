// AIR-675 / ADR 0217 (Accepted) decision 8b: the ONE common generator of the ATTACH ROOT, the causal root of the evidence row `film_has_id(film, tmdb_movie)` that a later verified TMDB movie of a lid-only Film writes.
// PURE: no storage, network or clock. It is the ONE common generator for every real page-check route: the Diary and Watchlist check (`LetterboxdDiaryIdentity.checkOne`), the rated-archive step (`identityStep`) and the owner re-check
// (`src/admin/lid-recheck.js`, whose attach is dormant until the writer is `on`). The first three write it as the causal root of their evidence rows; the owner re-check writes it as the root of the attach row.
//
// `attach_root = sha256([proof_version, lid, slug, path, tmdb, 'movie', title, year, source, tmdb_doc_digest])`: the existing page-check evidence digest of ADR 0207 decision 3 (`lid, slug, path, tmdb, title, year, source`)
// extended with `proof_version`, the TMDB type, and the digest of the TMDB document fields the agreement check compares (id, title, original title, release year).
//  - `proof_version` names the check rules and the normalization below, never a route; it changes whenever a rule changes.
//  - `source` is the NORMALIZED final film page URL (`https`, lowercase host, no query, no fragment, one trailing slash), never a route name. The route stays in the observation metadata, so the Diary, the Watchlist, the rated
//    step and the owner re-check checking the same page give the SAME root, and a different caller never manufactures independent corroboration (ADR 0213: independence counts distinct roots). This function takes NO route.
//  - The agreement inputs are hashed in the normalized form `movieDetailAgrees` already compares (`agreementNorm`); nothing new is normalized.
//  - Every input is stored on the intent row (`lid_recheck_intent`), so the root can be recomputed. No raw HTML is archived. Nothing is fabricated: a failed agreement check has no root (the caller never calls this).
// An existing route's legacy digest (`pageCheckDigest` of the Diary, the archive's own digest) is NOT rewritten: it stays the admission receipt's digest (replay compatibility) and route provenance on the evidence row. The coordinator
// (`letterboxd-admission-d1.js`, `evidencePlans`) computes the receipt content digest from the LEGACY evidence key and adopts the legacy root for a source that already has a legacy evidence row, so old and new encodings of one source are never
// counted as independent proof.
import {agreementNorm} from './letterboxd-rated-admission.js';
import {normalizeFilmUrl} from './letterboxd-lid-only-digest.js';

export const ATTACH_PROOF_VERSION = 1;
const LID = /^[A-Za-z0-9_-]{1,80}$/;
const TMDB = /^[1-9]\d{0,11}$/;
const SLUG = /^[a-z0-9-]{1,200}$/;
const sha256Hex = async text => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(byte => byte.toString(16).padStart(2, '0')).join('');

// The digest of the TMDB document fields the agreement check compares: the id, the title and the original title (both in the compared normalization) and the release year (or null).
export async function tmdbDocumentDigest(detail) {
  if (!detail || typeof detail !== 'object') return null;
  const release = Number(String(detail.release_date || '').slice(0, 4));
  return sha256Hex(JSON.stringify([String(detail.id), agreementNorm(detail.title), agreementNorm(detail.original_title), Number.isFinite(release) && release > 0 ? release : null]));
}

// input: {lid, slug, path, tmdb, title, year, finalUrl, detail} -> {root, tmdbDocDigest, source, proofVersion} or null when an input is not valid (the caller then writes no root).
// `path` is the canonical film path (`/film/<slug>/`); `finalUrl` is the landing URL of the page check (normalized here); `detail` is the TMDB movie document the agreement check passed.
export async function attachRoot({lid, slug, path, tmdb, title, year, finalUrl, detail} = {}) {
  if (!LID.test(String(lid || '')) || !SLUG.test(String(slug || '')) || !TMDB.test(String(tmdb || ''))) return null;
  if (path !== '/film/' + slug + '/') return null;
  if (typeof title !== 'string' || !title.trim() || title !== title.trim()) return null;
  if (!Number.isInteger(year) || year < 1800 || year > 2200) return null;
  const source = normalizeFilmUrl(finalUrl);
  if (!source || source !== 'https://letterboxd.com' + path) return null;
  if (String(detail?.id) !== String(tmdb)) return null;
  const tmdbDocDigest = await tmdbDocumentDigest(detail);
  if (!tmdbDocDigest) return null;
  const root = await sha256Hex(JSON.stringify([ATTACH_PROOF_VERSION, lid, slug, path, String(tmdb), 'movie', title, year, source, tmdbDocDigest]));
  return {root, tmdbDocDigest, source, proofVersion: ATTACH_PROOF_VERSION};
}
