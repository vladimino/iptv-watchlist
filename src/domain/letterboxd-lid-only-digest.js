// AIR-672 / ADR 0217 (Accepted) decisions 7 and 8b: the pure, import-free part of the lid-only page proof that the canonical Film writer (bundled into the Worker) needs: the proof version,
// the normalized final film page URL and the recomputable proof digest (K2). The page check itself (`letterboxd-lid-only-proof.js`) builds on it and is not part of the Worker bundle until a later delivery step wires it.
export const LID_ONLY_PROOF_VERSION = 1;
const sha256Hex = async text => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(byte => byte.toString(16).padStart(2, '0')).join('');

// The normalized final film page URL: https, lowercase host, no query, no fragment, one trailing slash (decision 8b, `source`).
export function normalizeFilmUrl(value) {
  let url;
  try { url = new URL(String(value)); } catch { return null; }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'letterboxd.com' || url.username || url.password || url.port) return null;
  const path = url.pathname.replace(/\/+$/, '') + '/';
  return 'https://letterboxd.com' + path;
}

// The proof digest: sha256 over a fixed-order record of every input, each also stored in its own column of `film_lid_admission` so the digest can be recomputed. `year` is null when unknown.
export async function lidOnlyProofDigest(proof) {
  const fields = [proof.proofVersion, proof.lid, proof.finalUrl, proof.slug, proof.canonicalPath, proof.shortlink, proof.typeMarker, proof.idBlockOutcome, proof.completenessOutcome, proof.title, proof.year ?? null];
  return sha256Hex(JSON.stringify(fields));
}
