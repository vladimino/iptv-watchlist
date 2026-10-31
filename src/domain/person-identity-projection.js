// Consumer reference over the canonical Person grouping. Role records stay role- and source-specific;
// this module answers, for one selector, which of those records are one human and whether a watchlist
// filter and a catalog filter may use them. Both filters call filmsForPerson. A review candidate is
// never a member: a shared name, an ambiguous credit and a refused join do not add films.
//
// The caller passes records it already loaded. This module does not query and does not write.
// One GET, the person identity route, loads a bounded D1 neighborhood and calls it. The live site
// still matches the role-specific id. R2 stays the authority. Nothing here is stored, so an owner
// `different` is undone by projecting again.

import {canonicalPersons, filmVerified, personKey} from './canonical-person.js';

export const PERSON_IDENTITY_PROJECTION_VERSION = 1;
export const PERSON_REFERENCE_STATES = ['trusted', 'unresolved', 'ambiguous', 'conflicting'];
export const PERSON_CROSS_SOURCE = ['verified', 'refused', 'ambiguous', 'none'];
const ROLES = ['actor', 'director'];
const SURFACES = ['watchlist', 'catalog'];
const REVIEW_ORDER = ['ambiguous_co_credit', 'conflicting_keys', 'owner_different', 'name_only', 'same_name'];

function text(left, right) {
  return String(left ?? '').localeCompare(String(right ?? ''), 'en');
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function surfacesOf(films) {
  const map = new Map();
  const issues = [];
  const reported = new Set();
  for (const film of list(films)) {
    if (!film || typeof film.id !== 'string' || !film.id) continue;
    const surface = SURFACES.includes(film.surface) ? film.surface : null;
    if (!map.has(film.id)) {
      map.set(film.id, surface);
      continue;
    }
    if (map.get(film.id) === surface) continue;
    if (!reported.has(film.id)) {
      issues.push({code: 'conflicting_surface', filmId: film.id});
      reported.add(film.id);
    }
    map.set(film.id, null);
  }
  issues.sort((a, b) => text(a.filmId, b.filmId));
  return {map, issues};
}

function candidateHumans(candidate, humanOf) {
  const ids = new Set(list(candidate.humanIds));
  for (const personId of list(candidate.personIds)) if (humanOf[personId]) ids.add(humanOf[personId]);
  return [...ids].sort(text);
}

function reviewOf(candidate, humanIds) {
  return {
    reason: candidate.reason,
    humanIds,
    personIds: list(candidate.personIds).slice().sort(text),
    films: list(candidate.films).slice().sort(text),
    roles: list(candidate.roles).slice().sort(text),
    names: list(candidate.names).slice().sort(text),
    source: candidate.source ?? null
  };
}

function crossSourceOf(memberIds, links, reviews) {
  const sources = new Set(memberIds.map(id => personKey(id)?.source).filter(Boolean));
  if (sources.has('letterboxd') && sources.has('tmdb') && links.some(link => link.basis === 'co_credit' || link.basis === 'owner')) return 'verified';
  const reasons = new Set(reviews.map(review => review.reason));
  if (reasons.has('owner_different') || reasons.has('conflicting_keys')) return 'refused';
  if (reasons.has('ambiguous_co_credit')) return 'ambiguous';
  return 'none';
}

// A verified join (source key, coCredit or owner `same`) makes the members one human. Reviews stay
// attached and are not members. Without a verified join, a refusal is conflicting and any other
// candidate is ambiguous; a record with neither is unresolved.
function stateOf(links, reviews) {
  if (links.length) return 'trusted';
  const reasons = new Set(reviews.map(review => review.reason));
  if (reasons.has('conflicting_keys') || reasons.has('owner_different')) return 'conflicting';
  if (reasons.has('ambiguous_co_credit') || reasons.has('name_only') || reasons.has('same_name')) return 'ambiguous';
  return 'unresolved';
}

function referenceFrom(human, reviews, surfaceOf) {
  const links = human.links.slice().sort((a, b) => text(a.basis, b.basis) || text((a.personIds || []).join(' '), (b.personIds || []).join(' ')));
  const credits = human.credits.map(credit => ({filmId: credit.filmId, role: credit.role, surface: surfaceOf.get(credit.filmId) ?? null}));
  credits.sort((a, b) => text(a.filmId, b.filmId) || text(a.role, b.role));
  return {
    humanId: human.id,
    formerIds: human.formerIds.slice(),
    state: stateOf(links, reviews),
    crossSource: crossSourceOf(human.memberIds, links, reviews),
    memberIds: human.memberIds.slice(),
    roles: human.roles.slice(),
    externalIds: human.externalIds.map(item => ({
      scheme: item.scheme,
      value: item.value,
      trusted: item.trusted === true,
      conflicting: item.conflicting === true,
      provenance: {source: 'person_record_id', personIds: item.personIds.slice()}
    })),
    original: human.original,
    preferred: human.preferred,
    nameConflicts: human.nameConflicts.slice(),
    aliases: human.aliases.slice(),
    links,
    reviews,
    credits,
    reversal: {
      destructive: false,
      stored: false,
      formerIds: human.formerIds.slice(),
      splits: splitPairs(links)
    }
  };
}

// One owner `different` names exactly two records. A coCredit link can list every role of both
// source groups, so the inverse is one pair per pair of groups: the smallest record of each group.
// Applying those pairs on the next projection separates the groups and leaves a source key intact.
function splitPairs(links) {
  const pairs = [];
  const seen = new Set();
  for (const link of links) {
    if (link.basis !== 'co_credit' && link.basis !== 'owner') continue;
    const byNode = new Map();
    for (const id of list(link.personIds)) {
      const node = personKey(id)?.node;
      if (!node) continue;
      if (!byNode.has(node)) byNode.set(node, []);
      byNode.get(node).push(id);
    }
    const nodes = [...byNode.keys()].sort(text);
    if (nodes.length < 2) continue;
    const anchor = byNode.get(nodes[0]).sort(text)[0];
    for (const node of nodes.slice(1)) {
      const personIds = [anchor, byNode.get(node).sort(text)[0]].sort(text);
      const key = personIds.join('\n');
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({personIds, verdict: 'different', at: link.at ?? null, basis: 'reversal'});
    }
  }
  pairs.sort((a, b) => text(a.personIds.join('\n'), b.personIds.join('\n')) || text(a.at, b.at));
  return pairs;
}

function trustedIdentity(film) {
  return list(film.externalIds)
    .filter(item => item && (item.scheme === 'tmdb' || item.scheme === 'tmdb_tv') && item.trusted === true && item.conflicting !== true)
    .map(item => item.scheme + ':' + String(item.value))
    .sort(text)
    .join(',');
}

// A film id given twice is coCredit evidence only when the copies agree. A contradictory surface,
// verification or trusted identity is passed as unverified, so it cannot join two sources. The
// credit itself stays on each record.
function evidenceFilms(films) {
  const groups = new Map();
  for (const film of list(films)) {
    if (!film || typeof film.id !== 'string' || !film.id) continue;
    if (!groups.has(film.id)) groups.set(film.id, []);
    groups.get(film.id).push(film);
  }
  const issues = [];
  const out = [];
  for (const [id, copies] of [...groups.entries()].sort((a, b) => text(a[0], b[0]))) {
    const surfaces = new Set(copies.map(film => (SURFACES.includes(film.surface) ? film.surface : null)));
    const flags = copies.map(film => filmVerified(film));
    const identities = new Set(copies.map(trustedIdentity).filter(Boolean));
    const canons = new Set(copies.map(film => (typeof film.canonicalIdentity === 'string' ? film.canonicalIdentity : '')).filter(Boolean));
    const contradictory = copies.length > 1 && (surfaces.size > 1 || new Set(flags).size > 1 || identities.size > 1 || canons.size > 1);
    if (contradictory) {
      if (new Set(flags).size > 1 || identities.size > 1 || canons.size > 1) issues.push({code: 'conflicting_film', filmId: id});
      out.push({id, verified: false});
      continue;
    }
    out.push({id, verified: flags[0] === true});
  }
  issues.sort((a, b) => text(a.filmId, b.filmId));
  return {films: out, issues};
}

function unknown(status = 'unknown') {
  return {
    status,
    crossSource: null,
    humanId: null,
    formerIds: [],
    memberIds: [],
    roles: [],
    externalIds: [],
    links: [],
    reviews: [],
    preferred: null,
    aliases: [],
    nameConflicts: [],
    reversal: {destructive: false, stored: false, formerIds: [], splits: []}
  };
}

export function projectPersonIdentity(input) {
  const source = input && typeof input === 'object' ? input : {};
  const surfaces = surfacesOf(source.films);
  const evidence = evidenceFilms(source.films);
  const grouping = canonicalPersons({persons: source.persons, credits: source.credits, films: evidence.films, decisions: source.decisions});
  const reviewsOf = new Map();
  for (const candidate of grouping.candidates) {
    const humanIds = candidateHumans(candidate, grouping.humanOf);
    const review = reviewOf(candidate, humanIds);
    for (const humanId of humanIds) {
      if (!reviewsOf.has(humanId)) reviewsOf.set(humanId, []);
      reviewsOf.get(humanId).push(review);
    }
  }
  for (const reviews of reviewsOf.values()) {
    reviews.sort((a, b) => REVIEW_ORDER.indexOf(a.reason) - REVIEW_ORDER.indexOf(b.reason) || text(a.humanIds.join(' '), b.humanIds.join(' ')) || text(a.names.join(' '), b.names.join(' ')) || text(a.films.join(' '), b.films.join(' ')));
  }
  const references = grouping.humans
    .map(human => referenceFrom(human, reviewsOf.get(human.id) || [], surfaces.map))
    .sort((a, b) => text(a.humanId, b.humanId));
  const totals = {references: references.length, trusted: 0, unresolved: 0, ambiguous: 0, conflicting: 0};
  for (const reference of references) totals[reference.state] += 1;
  const issues = [...grouping.issues, ...surfaces.issues, ...evidence.issues].sort((a, b) => text(JSON.stringify(a), JSON.stringify(b)));
  return {version: PERSON_IDENTITY_PROJECTION_VERSION, totals, references, issues};
}

// One selector is a human id (including a former id), a role-record id, or a typed external id.
// A name is not a selector. Two keys that name different humans resolve to nothing.
export function resolvePersonReference(projection, selector) {
  if (!projection || !selector || typeof selector !== 'object') return unknown();
  const references = list(projection.references);
  const keys = [];
  if (typeof selector.humanId === 'string' && selector.humanId) {
    keys.push(references.filter(reference => reference.humanId === selector.humanId || reference.formerIds.includes(selector.humanId)));
  }
  if (typeof selector.recordId === 'string' && selector.recordId) {
    keys.push(references.filter(reference => reference.memberIds.includes(selector.recordId)));
  }
  if (typeof selector.scheme === 'string' && selector.scheme && typeof selector.value === 'string' && selector.value) {
    keys.push(references.filter(reference => reference.externalIds.some(item => item.scheme === selector.scheme && item.value === selector.value)));
  }
  if (!keys.length || keys.some(found => found.length !== 1)) return unknown(keys.some(found => found.length > 1) ? 'conflicting' : 'unknown');
  const ids = new Set(keys.map(found => found[0].humanId));
  if (ids.size !== 1) return unknown('conflicting');
  const reference = keys[0][0];
  return {
    status: reference.state,
    crossSource: reference.crossSource,
    humanId: reference.humanId,
    formerIds: reference.formerIds.slice(),
    memberIds: reference.memberIds.slice(),
    roles: reference.roles.slice(),
    externalIds: reference.externalIds.slice(),
    links: reference.links.slice(),
    reviews: reference.reviews.slice(),
    preferred: reference.preferred,
    aliases: reference.aliases.slice(),
    nameConflicts: reference.nameConflicts.slice(),
    reversal: {destructive: false, stored: false, formerIds: reference.reversal.formerIds.slice(), splits: reference.reversal.splits.slice()}
  };
}

// The watchlist filter and the catalog filter. `surface` keeps one side; omitting it returns both.
// Only member credits of the requested role qualify. Reviews do not.
export function filmsForPerson(projection, query = {}) {
  const role = query?.role ?? null;
  const surface = query?.surface ?? null;
  const empty = {status: 'unknown', crossSource: null, humanId: null, memberIds: [], role, surface, films: []};
  if (!ROLES.includes(role) || (surface !== null && !SURFACES.includes(surface))) return empty;
  const reference = resolvePersonReference(projection, query?.selector);
  if (!reference.humanId) return {...empty, status: reference.status, role, surface};
  const found = list(projection.references).find(item => item.humanId === reference.humanId);
  const films = [];
  for (const credit of found?.credits || []) {
    if (credit.role !== role) continue;
    if (surface && credit.surface !== surface) continue;
    films.push(credit.filmId);
  }
  return {status: reference.status, crossSource: reference.crossSource, humanId: reference.humanId, memberIds: reference.memberIds, role, surface, films};
}

// Both surfaces of one selector. They share a human id because they share this projection.
export function personSurfaces(projection, selector, role) {
  const watchlist = filmsForPerson(projection, {selector, role, surface: 'watchlist'});
  const catalog = filmsForPerson(projection, {selector, role, surface: 'catalog'});
  return {
    same: watchlist.humanId !== null && watchlist.status === catalog.status && watchlist.humanId === catalog.humanId,
    status: watchlist.status,
    crossSource: watchlist.crossSource,
    humanId: watchlist.humanId,
    watchlist: watchlist.films,
    catalog: catalog.films
  };
}
