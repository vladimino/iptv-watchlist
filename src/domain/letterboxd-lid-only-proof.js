// AIR-672 / ADR 0217 (Accepted) decisions 2, 3 and 7: the H1 page proof of a lid-only admission and its recomputable digest (K2). PURE and DORMANT: no storage, network or clock, and nothing calls it from a live path.
// H1 is a complete, validated film page with a POSITIVELY absent TMDB relation. It is fail-closed twice over:
//  - `H1_RULES` ships EMPTY. The eligible page types and the external-id block marker are fixed from permitted existing captures of real no-TMDB pages (ADR 0217 delivery step 8, a hard pre-activation holdpoint);
//    until then no page can pass (`page_type_ineligible`, `tmdb_unreadable`) and no state is ever downgraded to `tmdb_none`. Synthetic tests pass their own `rules`; they prove the code, never the upstream markup.
//  - Only a page that passes EVERY check below is `tmdb_none`. A missing or unreadable block is `tmdb_unreadable`, never "no TMDB" (decision 2, check 6).
// The checks (decision 2): 1 the boxd.it redirect reaches `/film/<slug>/`; 2 the page answered 200 with a complete body; 3 it is not a challenge page; 4 its shortlink equals the lid and its canonical path equals the
// redirect target; 5 the film type marker is present, readable and in the eligible list, and the title is not empty; 6 the id block is present and holds no TMDB id of any type. The year is optional here only.
import {TMDB_STATES, pageTmdbObservation} from './letterboxd-rated-admission.js';
import {LID_ONLY_PROOF_VERSION, lidOnlyProofDigest, normalizeFilmUrl} from './letterboxd-lid-only-digest.js';
export {LID_ONLY_PROOF_VERSION, lidOnlyProofDigest, normalizeFilmUrl};

// PROVISIONAL and EMPTY on purpose (see above). `eligibleTypes`: the enumerated feature-film page types (the value of the page's film type marker); `idBlockMarker`: a regular expression SOURCE that matches
// the block where Letterboxd carries external ids, exactly once, so that its presence is positive and its absence of any TMDB id means something.
export const H1_RULES = Object.freeze({eligibleTypes: Object.freeze([]), idBlockMarker: null});

const LID = /^[A-Za-z0-9_-]{1,80}$/;
const SLUG = /^[a-z0-9-]{1,200}$/;
const typed = (state, extra = {}) => ({state, ...(TMDB_STATES[state] || {}), ...extra});
const refused = (state, outcome, extra = {}) => ({state, outcome, retryClass: 'definite', admits: false, ...extra});

// The page type marker: the one `og:type` meta of the page (an assumption of the PROVISIONAL rules; the real marker is fixed at step 8). Exactly one, non-empty, else unreadable (null).
function typeMarkerOf(html) {
  const values = [...html.matchAll(/<meta\b[^>]*>/gi)].map(match => match[0]).filter(tag => /\bproperty\s*=\s*["']og:type["']/i.test(tag)).map(tag => (/\bcontent\s*=\s*"([^"]*)"|\bcontent\s*=\s*'([^']*)'/i.exec(tag) || [])).map(found => found[1] ?? found[2] ?? null);
  return values.length === 1 && values[0] && values[0].length <= 40 ? values[0] : null;
}

// input: {lid, redirect: {status, location}, fetched: the follow result of the film page ({html, landing} or {stop} or {review, status}), evidence: pageEvidence of it (null when none), rules, checkedAt}
// -> {state, outcome, retryClass, admits, proof?}. State `tmdb_none` is the only admitting one and carries `proof` with every column and `proofDigest` (async digest => this function is async).
export async function lidOnlyPageProof({lid, redirect, fetched, evidence, rules = H1_RULES, checkedAt = null} = {}) {
  if (!LID.test(String(lid || ''))) return refused('lid_unverified', 'lid_unverified');
  // Check 1: the redirect must be a 3xx of boxd.it that lands on a film page (the existing follow already enforces the ADR 0166 hop limits and hosts).
  const redirectStatus = Number(redirect?.status);
  if (!Number.isInteger(redirectStatus) || redirectStatus < 300 || redirectStatus > 399) return refused('page_not_read', 'redirect_missing');
  // Checks 2 and 3 and the TMDB relation seen by the existing observation: a transport stop or a challenge stays unavailable; an incomplete or unparseable page is `tmdb_unreadable`; a page that names a TMDB id
  // (movie or tv) is not a lid-only page at all.
  const observed = pageTmdbObservation(fetched, evidence);
  if (observed.state === 'page_movie' || observed.state === 'tmdb_tv') return {...observed, admits: false};
  // `tmdb_unreadable` from the existing observation also covers "no id block / zero ids" for the MOVIE path. Here an absent id is what H1 looks for, so the page completeness is re-checked first and the absence is
  // established positively below; any other state of the observation (unavailable, not read) is final.
  if (observed.state !== 'tmdb_unreadable') return observed;
  const html = typeof fetched?.html === 'string' ? fetched.html : '';
  if (fetched?.stop || fetched?.review || !/<\/html\s*>\s*$/i.test(html) || !evidence || evidence.kind !== 'page') return typed('tmdb_unreadable');
  const finalUrl = normalizeFilmUrl(fetched.landing?.href ?? fetched.landing);
  if (!finalUrl) return refused('page_not_read', 'landing_not_film');
  const slugMatch = /^https:\/\/letterboxd\.com\/film\/([^/]+)\/$/.exec(finalUrl);
  const slug = slugMatch ? slugMatch[1] : null;
  if (!slug || !SLUG.test(slug)) return refused('page_not_read', 'slug_missing');
  const canonicalPath = '/film/' + slug + '/';
  // Check 4: the page's own shortlink equals the lid, and its canonical path equals the redirect target (the evidence path).
  if (evidence.shortCode !== lid) return refused('page_refused', evidence.shortlinkPresent ? 'shortlink_mismatch' : 'shortlink_missing');
  if (evidence.path !== canonicalPath || evidence.canonicalPath !== canonicalPath) return refused('page_refused', 'canonical_mismatch');
  // Check 6 first half: ANY TMDB relation in the raw markup (an id, a type, a themoviedb.org reference) means the page is not "no TMDB". An id the observation could not parse stays unreadable.
  if (/data-tmdb-(?:id|type)\b/i.test(html) || /themoviedb\.org/i.test(html) || (Array.isArray(evidence.tmdbIds) && evidence.tmdbIds.length) || (Array.isArray(evidence.tmdbTypes) && evidence.tmdbTypes.length)) return typed('tmdb_unreadable');
  // Check 5: the type marker is present, readable and eligible; the title is not empty. A readable marker of another type is NOT admitted (it is reviewed), an unreadable one is unreadable.
  const typeMarker = typeMarkerOf(html);
  if (!typeMarker) return typed('tmdb_unreadable');
  if (!Array.isArray(rules?.eligibleTypes) || !rules.eligibleTypes.includes(typeMarker)) return refused('page_type_ineligible', 'page_type_ineligible', {typeMarker});
  const title = typeof evidence.title === 'string' ? evidence.title.trim() : '';
  if (!title) return refused('page_refused', 'title_missing');
  // Check 6 second half: the id block must be PRESENT (positive absence), matched exactly once by the rules' marker. Without a configured marker or without a match the page is unreadable, never "no TMDB".
  let block = null;
  try { block = typeof rules?.idBlockMarker === 'string' && rules.idBlockMarker ? [...html.matchAll(new RegExp(rules.idBlockMarker, 'gi'))] : null; } catch { block = null; }
  if (!block || block.length !== 1) return typed('tmdb_unreadable');
  // The year is optional for a lid-only admission only: none or one distinct year is admitted; several disagreeing years are an inconsistent page, not a guess.
  const years = Array.isArray(evidence.years) ? evidence.years : [];
  if (years.length > 1) return refused('page_refused', 'page_year_inconsistent');
  const proof = {proofVersion: LID_ONLY_PROOF_VERSION, lid, finalUrl, slug, canonicalPath, shortlink: lid, typeMarker, idBlockOutcome: 'absent', completenessOutcome: 'complete', title, year: years.length ? years[0] : null,
    redirectStatus, pageStatus: 200, checkedAt};
  proof.proofDigest = await lidOnlyProofDigest(proof);
  return {state: 'tmdb_none', outcome: 'admitted_lid_only', retryClass: null, admits: true, proof};
}
