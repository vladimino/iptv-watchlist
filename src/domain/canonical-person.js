// Canonical Person groundwork, AIR-44. A Person record is role-specific (person:actor/<slug>, person:tmdb_director/<id>, …),
// so one human is stored once per role and once per source. This module groups those records into canonical humans from
// evidence alone, and says why: the same source key under several roles, a Letterboxd and a TMDB record credited in the same
// role on the same verified Film under the same accepted name (the coCredit of AIR-201), or an explicit owner decision.
// A shared name with no shared verified Film is a candidate for review, never a link (ADR-0009, ADR-0058).
// Pure and storage-neutral: the caller passes records it already loaded, from R2 lifecycle views or from D1 rows. No I/O, no
// clock, no writes. Nothing is merged destructively: every member record, alias and external id stays as it is, the output is
// a read model over them, and a later owner decision can split what the evidence joined.

export const CANONICAL_PERSON_VERSION = 1;
export const PERSON_SOURCES = ['letterboxd', 'tmdb'];
export const PERSON_LINK_BASES = ['same_key', 'owner', 'co_credit'];
export const PERSON_CANDIDATE_REASONS = ['ambiguous_co_credit', 'conflicting_keys', 'owner_different', 'name_only', 'same_name'];
export const PERSON_ISSUES = ['invalid_person', 'duplicate_person', 'unknown_person', 'invalid_credit', 'invalid_decision', 'owner_split_same_key'];

const PERSON_ID = /^person:(actor|director|tmdb_actor|tmdb_director|role)\/(.+)$/;
const PERSON_ROLES = ['actor', 'director'];
const NAME_RANKS = {owner: 4, reviewed: 3, provisional: 2};

function personText(left, right) {
  return String(left ?? '').localeCompare(String(right ?? ''), 'en');
}

function personObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// The folding of the admin query library and of the AIR-126 name review: Latin diacritics stripped, ё read as е, case folded,
// punctuation turned into spaces. Names are compared on folded text and stored as written.
export function personFold(value) {
  return String(value ?? '')
    .replace(/\p{Script=Latin}+/gu, chunk => chunk.normalize('NFD').replace(/\p{M}+/gu, ''))
    .replace(/ё/gi, 'е')
    .toLocaleLowerCase('ru')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// The identity authority behind one record id. A Letterboxd slug names one person page whatever role it is credited in, and
// so does a TMDB person id; a person:role/<text> record carries credit text only and has no key.
export function personKey(personId) {
  const match = typeof personId === 'string' ? personId.match(PERSON_ID) : null;
  if (!match) return null;
  const [, role, key] = match;
  if (role === 'role') return {source: null, key: null, role: null, node: 'record:' + personId};
  const source = role.startsWith('tmdb_') ? 'tmdb' : 'letterboxd';
  return {source, key, role: role.replace(/^tmdb_/, ''), node: source + ':' + key};
}

// Every name a record is known by, as the D1 review queues read them: the original credit text, the name aliases and an
// accepted (reviewed or provisional) localization. A name a reviewed localization holds back is not an accepted name.
export function personNames(person) {
  const names = [];
  const add = (value, origin, status) => {
    const text = typeof value === 'string' ? value.trim() : '';
    const folded = personFold(text);
    if (folded && !names.some(name => name.value === text)) names.push({value: text, folded, origin, status});
  };
  add(person?.original, 'original', null);
  for (const alias of person?.aliases || []) if (alias?.kind === 'name') add(alias.value, 'alias', null);
  const localization = person?.localization;
  if (localization && (localization.status === 'reviewed' || localization.status === 'provisional')) add(localization.value, 'localization', localization.status);
  return names;
}

// The rank of a record's preferred name: an owner review over a dictionary or other reviewed name over a provisional one.
function nameRank(person) {
  const localization = person?.localization;
  if (!localization?.value) return 0;
  if (localization.status === 'reviewed') return localization.provenance?.authority === 'owner' ? NAME_RANKS.owner : NAME_RANKS.reviewed;
  return localization.status === 'provisional' ? NAME_RANKS.provisional : 0;
}

// A Film is evidence for a coCredit only when its identity is verified: a trusted, non-conflicting TMDB movie or TV id, so
// that its TMDB credits and its Letterboxd credits describe the same work. A lifecycle view Film qualifies through its
// canonical identity or its external ids; a caller holding D1 rows passes {id, verified}.
export function filmVerified(film) {
  if (!personObject(film)) return false;
  if (typeof film.verified === 'boolean') return film.verified;
  if (film.identity?.status === 'rejected') return false;
  const trusted = (film.externalIds || []).filter(item => (item?.scheme === 'tmdb' || item?.scheme === 'tmdb_tv') && item.trusted === true);
  if (trusted.some(item => item.conflicting)) return false;
  const values = new Set(trusted.map(item => item.scheme + ':' + item.value));
  return values.size === 1 || (values.size === 0 && typeof film.canonicalIdentity === 'string' && /^tmdb(_tv)?:\d+$/.test(film.canonicalIdentity));
}

// Applies the verified entries of data/person-names.json to records, as an offline projection: a verified dictionary name
// becomes a reviewed localization unless the record already holds an owner review, which keeps its name and holds the
// dictionary value as a conflict (reviewed precedence, AIR-126). A dictionary entry for a record not supplied adds nothing.
// Returns new records; the inputs are not changed.
export function withVerifiedNames(persons, dictionary) {
  const entries = new Map();
  for (const entry of Array.isArray(dictionary) ? dictionary : []) {
    if (entry?.status !== 'verified' || typeof entry.id !== 'string' || typeof entry.name !== 'string' || !entry.name.trim()) continue;
    entries.set('person:' + entry.id, entry);
  }
  return (Array.isArray(persons) ? persons : []).map(person => {
    const entry = entries.get(person?.id);
    if (!entry) return person;
    const value = entry.name.trim();
    const aliases = [...(person.aliases || [])];
    for (const alias of entry.aliases || []) if (typeof alias === 'string' && alias.trim() && !aliases.some(item => item?.kind === 'name' && item.value === alias.trim())) aliases.push({kind: 'name', value: alias.trim(), provenance: {source: 'dictionary'}});
    const current = person.localization;
    if (current?.status === 'reviewed' && current.provenance?.authority === 'owner') {
      if (current.value === value) return {...person, aliases};
      const held = (person.localizationConflicts || []).some(item => item?.value === value) ? person.localizationConflicts : [...(person.localizationConflicts || []), {value, source: 'dictionary', reason: 'owner_kept'}];
      return {...person, aliases, localizationConflicts: held};
    }
    if (current?.value && current.value !== value && !aliases.some(item => item?.kind === 'name' && item.value === current.value)) aliases.push({kind: 'name', value: current.value, provenance: {source: current.source || null}});
    return {...person, aliases, localization: {status: 'reviewed', value, source: 'dictionary', provenance: {authority: 'dictionary', basis: entry.verification_basis || null}}};
  });
}

function unionFind() {
  const parent = new Map();
  const find = node => {
    if (!parent.has(node)) parent.set(node, node);
    let root = node;
    while (parent.get(root) !== root) root = parent.get(root);
    while (parent.get(node) !== root) {
      const next = parent.get(node);
      parent.set(node, root);
      node = next;
    }
    return root;
  };
  // The smaller node becomes the root, so the grouping never depends on input order.
  const union = (left, right) => {
    const a = find(left), b = find(right);
    if (a === b) return false;
    if (personText(a, b) < 0) parent.set(b, a); else parent.set(a, b);
    return true;
  };
  return {find, union};
}

function pairKey(left, right) {
  return personText(left, right) <= 0 ? left + '\n' + right : right + '\n' + left;
}

// Owner decisions, latest first: a pair the owner called the same human and later different (or the reverse) takes the later
// verdict; at the same time, or with no time, `different` wins. AIR-126 role links recorded on a record are owner `same`
// decisions with the review's time. Two entries of one verdict at the same time are one decision told twice: an explicit
// decision is kept over a role link, then the smaller basis text, so the recorded provenance never depends on input order.
function ownerVerdicts(decisions, persons, known, excluded, issues) {
  const entries = [];
  for (const decision of Array.isArray(decisions) ? decisions : []) {
    const ids = Array.isArray(decision?.personIds) ? decision.personIds : [];
    if (ids.length !== 2 || ids[0] === ids[1] || !['same', 'different'].includes(decision?.verdict)) {
      issues.push({code: 'invalid_decision', personIds: ids.slice(0, 2)});
      continue;
    }
    const missing = ids.filter(id => !known.has(id)).sort(personText);
    if (missing.length) {
      if (missing.some(id => !excluded.has(id))) issues.push({code: 'unknown_person', personIds: missing.filter(id => !excluded.has(id)), from: 'decision'});
      continue;
    }
    entries.push({personIds: [...ids].sort(personText), verdict: decision.verdict, at: decision.at ?? null, basis: decision.basis ?? null, origin: 'decision'});
  }
  for (const person of persons) {
    for (const link of person.roleLinks || []) {
      if (typeof link?.id !== 'string' || link.id === person.id || !known.has(link.id)) continue;
      entries.push({personIds: [person.id, link.id].sort(personText), verdict: 'same', at: link.at ?? null, basis: link.reason ?? 'owner_same_person', origin: 'role_link'});
    }
  }
  const verdicts = new Map();
  for (const entry of entries) {
    const key = pairKey(...entry.personIds);
    const held = verdicts.get(key);
    if (!held || ownerPrecedes(entry, held)) verdicts.set(key, entry);
  }
  return [...verdicts.values()].sort((a, b) => personText(pairKey(...a.personIds), pairKey(...b.personIds)));
}

function ownerPrecedes(entry, held) {
  const time = personText(entry.at, held.at);
  if (time) return time > 0;
  if (entry.verdict !== held.verdict) return entry.verdict === 'different';
  if (entry.origin !== held.origin) return entry.origin === 'decision';
  return personText(entry.basis, held.basis) < 0;
}

// Sorted keys, so two records that differ only in key order compare equal.
function personStable(value) {
  if (Array.isArray(value)) return '[' + value.map(personStable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + personStable(value[key])).join(',') + '}';
  return JSON.stringify(value ?? null);
}

// The canonical humans of a set of Person records. Input:
// - persons: records shaped like the lifecycle personView (id, original, aliases, localization, roleLinks);
// - credits: {filmId, personId, role} with role actor or director;
// - films: lifecycle view Films or {id, verified}; only verified Films carry coCredit evidence;
// - decisions: owner decisions {personIds: [a, b], verdict: same|different, at, basis}.
// Grouping runs in three steps, each order-independent:
// 1. same_key: records of one source key (a Letterboxd slug or a TMDB person id) under different roles are one human;
// 2. owner: an owner `same` joins two groups, an owner `different` forbids a join; the owner cannot split a source key;
// 3. co_credit: a Letterboxd group and a TMDB group join when, on at least one verified Film, each is the only record of its
//    source credited in that role under a shared accepted name, and each has that evidence with no other group. Every other
//    pair with evidence stays a candidate: shared with another group (ambiguous_co_credit), joining two different keys of
//    one source (conflicting_keys) or refused by the owner (owner_different).
export function canonicalPersons({persons = [], credits = [], films = [], decisions = []} = {}) {
  const issues = [];
  // Records supplied twice: identical copies count once; copies that differ are left out entirely, with their credits and
  // decisions, because no rule can pick one without depending on input order. Nothing is joined on a record in doubt.
  const copies = new Map();
  for (const person of Array.isArray(persons) ? persons : []) {
    if (!personObject(person) || !personKey(person.id)) {
      issues.push({code: 'invalid_person', personId: personObject(person) ? person.id ?? null : null});
      continue;
    }
    if (!copies.has(person.id)) copies.set(person.id, []);
    copies.get(person.id).push(person);
  }
  const byId = new Map();
  const excluded = new Set();
  for (const [id, list] of copies) {
    const forms = new Set(list.map(personStable));
    if (list.length > 1) issues.push({code: 'duplicate_person', personId: id, copies: list.length, conflicting: forms.size > 1});
    if (forms.size > 1) excluded.add(id); else byId.set(id, list[0]);
  }
  const ids = [...byId.keys()].sort(personText);
  const records = ids.map(id => byId.get(id));
  const nodeOf = id => personKey(id).node;
  const groups = unionFind();
  for (const id of ids) groups.find(nodeOf(id));

  // 1 and 2: owner verdicts over source keys.
  const verdicts = ownerVerdicts(decisions, records, byId, excluded, issues);
  const refused = [];
  for (const verdict of verdicts) {
    const [left, right] = verdict.personIds;
    if (verdict.verdict === 'different') {
      if (nodeOf(left) === nodeOf(right)) issues.push({code: 'owner_split_same_key', personIds: verdict.personIds, key: nodeOf(left)});
      else refused.push(verdict);
    }
  }
  const ownerLinks = [];
  const refusedBetween = (leftRoot, rightRoot) => refused.some(item => {
    const a = groups.find(nodeOf(item.personIds[0])), b = groups.find(nodeOf(item.personIds[1]));
    return (a === leftRoot && b === rightRoot) || (a === rightRoot && b === leftRoot);
  });
  for (const verdict of verdicts) {
    if (verdict.verdict !== 'same') continue;
    const [left, right] = verdict.personIds;
    const a = groups.find(nodeOf(left)), b = groups.find(nodeOf(right));
    if (a !== b && refusedBetween(a, b)) {
      issues.push({code: 'invalid_decision', personIds: verdict.personIds, reason: 'contradicts_owner_different'});
      continue;
    }
    groups.union(a, b);
    ownerLinks.push(verdict);
  }

  // 3: coCredit evidence on verified Films.
  const verified = new Set();
  for (const film of Array.isArray(films) ? films : []) if (filmVerified(film) && typeof film.id === 'string') verified.add(film.id);
  const slots = new Map();
  const seenCredit = new Set();
  const creditsOf = new Map();
  for (const credit of Array.isArray(credits) ? credits : []) {
    if (!personObject(credit) || typeof credit.filmId !== 'string' || !PERSON_ROLES.includes(credit.role) || typeof credit.personId !== 'string') {
      issues.push({code: 'invalid_credit', filmId: credit?.filmId ?? null, personId: credit?.personId ?? null});
      continue;
    }
    if (!byId.has(credit.personId)) {
      if (!excluded.has(credit.personId)) issues.push({code: 'unknown_person', personIds: [credit.personId], from: 'credit'});
      continue;
    }
    const once = credit.filmId + '\n' + credit.role + '\n' + credit.personId;
    if (seenCredit.has(once)) continue;
    seenCredit.add(once);
    if (!creditsOf.has(credit.personId)) creditsOf.set(credit.personId, []);
    creditsOf.get(credit.personId).push({filmId: credit.filmId, role: credit.role});
    const source = personKey(credit.personId).source;
    if (!source || !verified.has(credit.filmId)) continue;
    for (const name of personNames(byId.get(credit.personId))) {
      const slot = credit.filmId + '\n' + credit.role + '\n' + name.folded;
      if (!slots.has(slot)) slots.set(slot, {filmId: credit.filmId, role: credit.role, name: name.folded, letterboxd: new Set(), tmdb: new Set()});
      slots.get(slot)[source].add(credit.personId);
    }
  }
  const evidence = new Map();
  const ambiguousSlots = [];
  for (const slot of slots.values()) {
    if (!slot.letterboxd.size || !slot.tmdb.size) continue;
    if (slot.letterboxd.size > 1 || slot.tmdb.size > 1) {
      ambiguousSlots.push({filmId: slot.filmId, role: slot.role, name: slot.name, personIds: [...slot.letterboxd, ...slot.tmdb].sort(personText)});
      continue;
    }
    const left = [...slot.letterboxd][0], right = [...slot.tmdb][0];
    const key = pairKey(left, right);
    if (!evidence.has(key)) evidence.set(key, {letterboxd: left, tmdb: right, films: new Set(), roles: new Set(), names: new Set()});
    const item = evidence.get(key);
    item.films.add(slot.filmId);
    item.roles.add(slot.role);
    item.names.add(slot.name);
  }
  // Evidence lifted to groups: a pair of groups joins only when each has evidence with that one group alone.
  const pairs = new Map();
  for (const item of evidence.values()) {
    const left = groups.find(nodeOf(item.letterboxd)), right = groups.find(nodeOf(item.tmdb));
    if (left === right) continue;
    const key = pairKey(left, right);
    if (!pairs.has(key)) pairs.set(key, {left, right, evidence: []});
    pairs.get(key).evidence.push(item);
  }
  const partners = new Map();
  for (const pair of pairs.values()) {
    for (const [own, other] of [[pair.left, pair.right], [pair.right, pair.left]]) {
      if (!partners.has(own)) partners.set(own, new Set());
      partners.get(own).add(other);
    }
  }
  const keysOf = new Map();
  for (const id of ids) {
    const root = groups.find(nodeOf(id)), key = personKey(id);
    if (!keysOf.has(root)) keysOf.set(root, {letterboxd: new Set(), tmdb: new Set()});
    if (key.source) keysOf.get(root)[key.source].add(key.key);
  }
  const candidates = [];
  const coCreditLinks = [];
  const evidenceOut = items => {
    const filmsOut = [...new Set(items.flatMap(item => [...item.films]))].sort(personText);
    return {
      personIds: [...new Set(items.flatMap(item => [item.letterboxd, item.tmdb]))].sort(personText),
      films: filmsOut,
      roles: [...new Set(items.flatMap(item => [...item.roles]))].sort(personText),
      names: [...new Set(items.flatMap(item => [...item.names]))].sort(personText)
    };
  };
  const accepted = [];
  for (const pair of [...pairs.values()].sort((a, b) => personText(pairKey(a.left, a.right), pairKey(b.left, b.right)))) {
    const out = evidenceOut(pair.evidence);
    const leftKeys = keysOf.get(pair.left), rightKeys = keysOf.get(pair.right);
    const clash = PERSON_SOURCES.some(source => leftKeys[source].size && rightKeys[source].size && [...leftKeys[source]].some(key => !rightKeys[source].has(key)));
    if (partners.get(pair.left).size > 1 || partners.get(pair.right).size > 1) candidates.push({reason: 'ambiguous_co_credit', ...out});
    else if (clash) candidates.push({reason: 'conflicting_keys', ...out});
    else if (refusedBetween(pair.left, pair.right)) candidates.push({reason: 'owner_different', ...out});
    else accepted.push({pair, out});
  }
  for (const {pair, out} of accepted) {
    groups.union(pair.left, pair.right);
    coCreditLinks.push(out);
  }
  for (const slot of ambiguousSlots) candidates.push({reason: 'ambiguous_co_credit', personIds: slot.personIds, films: [slot.filmId], roles: [slot.role], names: [slot.name]});

  // Humans.
  const members = new Map();
  for (const id of ids) {
    const root = groups.find(nodeOf(id));
    if (!members.has(root)) members.set(root, []);
    members.get(root).push(id);
  }
  const humanOf = new Map();
  const humans = [];
  for (const memberIds of members.values()) {
    const human = humanView(memberIds, byId, creditsOf, ownerLinks, coCreditLinks);
    for (const id of memberIds) humanOf.set(id, human.id);
    humans.push(human);
  }
  humans.sort((a, b) => personText(a.id, b.id));

  // Names shared by humans that no evidence joined: across sources (name_only) and within one source (same_name).
  const named = new Map();
  for (const human of humans) {
    for (const id of human.memberIds) {
      const source = personKey(id).source;
      if (!source) continue;
      for (const name of personNames(byId.get(id))) {
        if (!named.has(name.folded)) named.set(name.folded, {letterboxd: new Set(), tmdb: new Set()});
        named.get(name.folded)[source].add(human.id);
      }
    }
  }
  const evidenced = new Set(candidates.flatMap(item => {
    const own = [...new Set(item.personIds.map(id => humanOf.get(id)))];
    return own.flatMap(left => own.map(right => left + '\n' + right));
  }));
  for (const [name, holders] of [...named.entries()].sort((a, b) => personText(a[0], b[0]))) {
    const both = [...new Set([...holders.letterboxd, ...holders.tmdb])].sort(personText);
    if (holders.letterboxd.size && holders.tmdb.size && both.length > 1) {
      const loose = both.filter(left => both.some(right => left !== right && !evidenced.has(left + '\n' + right)));
      if (loose.length > 1) candidates.push({reason: 'name_only', humanIds: loose, names: [name]});
    }
    for (const source of PERSON_SOURCES) if (holders[source].size > 1) candidates.push({reason: 'same_name', source, humanIds: [...holders[source]].sort(personText), names: [name]});
  }
  candidates.sort((a, b) => PERSON_CANDIDATE_REASONS.indexOf(a.reason) - PERSON_CANDIDATE_REASONS.indexOf(b.reason) || personText((a.personIds || a.humanIds).join(' '), (b.personIds || b.humanIds).join(' ')) || personText(a.names.join(' '), b.names.join(' ')) || personText((a.films || []).join(' '), (b.films || []).join(' ')));

  issues.sort((a, b) => personText(personStable(a), personStable(b)));
  const totals = {persons: ids.length, humans: humans.length, joined: humans.filter(human => human.memberIds.length > 1).length, links: {same_key: 0, owner: 0, co_credit: 0}, candidates: {}, issues: issues.length};
  for (const human of humans) for (const link of human.links) totals.links[link.basis] += 1;
  for (const reason of PERSON_CANDIDATE_REASONS) totals.candidates[reason] = candidates.filter(item => item.reason === reason).length;
  return {version: CANONICAL_PERSON_VERSION, totals, humans, humanOf: Object.fromEntries([...humanOf.entries()].sort((a, b) => personText(a[0], b[0]))), candidates, issues};
}

// One canonical human from its member records. Its id comes from the strongest key it holds, Letterboxd first, then TMDB, then
// a keyless record's own id; the ids each member key would have had alone are kept as formerIds, so a reader that stored an
// earlier id still finds the human. The preferred name is the highest-ranked localization of any member (owner review, then
// reviewed, then provisional); two different names of the same rank are a nameConflict, kept as aliases, never dropped.
function humanView(memberIds, byId, creditsOf, ownerLinks, coCreditLinks) {
  const keys = {letterboxd: new Set(), tmdb: new Set()};
  const keyless = [];
  for (const id of memberIds) {
    const key = personKey(id);
    if (key.source) keys[key.source].add(key.key); else keyless.push(id);
  }
  const keyIds = [...[...keys.letterboxd].sort(personText).map(key => 'human:letterboxd:' + key), ...[...keys.tmdb].sort(personText).map(key => 'human:tmdb:' + key), ...keyless.map(id => 'human:record:' + id.slice('person:'.length))];
  const id = keyIds[0];
  const inGroup = new Set(memberIds);
  const links = [];
  for (const source of PERSON_SOURCES) {
    for (const key of [...keys[source]].sort(personText)) {
      const sameKey = memberIds.filter(member => personKey(member).source === source && personKey(member).key === key);
      if (sameKey.length > 1) links.push({basis: 'same_key', key: source + ':' + key, personIds: sameKey});
    }
  }
  for (const link of ownerLinks) if (link.personIds.every(member => inGroup.has(member))) links.push({basis: 'owner', personIds: link.personIds, at: link.at, decision: link.origin, reason: link.basis});
  for (const link of coCreditLinks) if (link.personIds.every(member => inGroup.has(member))) links.push({basis: 'co_credit', personIds: link.personIds, films: link.films, roles: link.roles, names: link.names});

  const order = (a, b) => {
    const left = personKey(a.id), right = personKey(b.id);
    const rank = source => source === 'letterboxd' ? 0 : source === 'tmdb' ? 1 : 2;
    return rank(left.source) - rank(right.source) || personText(a.id, b.id);
  };
  const records = memberIds.map(member => byId.get(member)).sort(order);
  const top = Math.max(0, ...records.map(nameRank));
  const preferredBy = top ? records.filter(record => nameRank(record) === top) : [];
  const chosen = preferredBy[0] || null;
  const nameConflicts = [];
  for (const record of preferredBy.slice(1)) {
    if (personFold(record.localization.value) !== personFold(chosen.localization.value) && !nameConflicts.some(item => item.value === record.localization.value)) nameConflicts.push({value: record.localization.value, personId: record.id, status: record.localization.status, source: record.localization.source ?? null});
  }
  const preferred = chosen
    ? {value: chosen.localization.value, status: chosen.localization.status, source: chosen.localization.source ?? null, authority: chosen.localization.provenance?.authority ?? null, personId: chosen.id}
    : {value: null, status: 'missing', source: null, authority: null, personId: null};
  const original = records.find(record => typeof record.original === 'string' && record.original.trim())?.original.trim() ?? null;
  const aliases = [];
  for (const record of records) {
    const names = [...personNames(record), ...(record.localizationConflicts || []).filter(item => typeof item?.value === 'string' && item.value.trim()).map(item => ({value: item.value.trim(), origin: 'held'}))];
    for (const name of names) {
      if (name.value === preferred.value) continue;
      let alias = aliases.find(item => item.value === name.value);
      if (!alias) {
        alias = {value: name.value, personIds: [], origins: []};
        aliases.push(alias);
      }
      if (!alias.personIds.includes(record.id)) alias.personIds.push(record.id);
      if (!alias.origins.includes(name.origin)) alias.origins.push(name.origin);
    }
  }
  const externalIds = [];
  for (const source of PERSON_SOURCES) {
    for (const key of [...keys[source]].sort(personText)) externalIds.push({scheme: source === 'tmdb' ? 'tmdb_person' : 'letterboxd_person', value: key, trusted: true, personIds: memberIds.filter(member => personKey(member).source === source && personKey(member).key === key)});
  }
  const credits = [];
  for (const member of memberIds) for (const credit of creditsOf.get(member) || []) {
    if (!credits.some(item => item.filmId === credit.filmId && item.role === credit.role)) credits.push({filmId: credit.filmId, role: credit.role});
  }
  credits.sort((a, b) => personText(a.filmId, b.filmId) || personText(a.role, b.role));
  const roles = [...new Set([...memberIds.map(member => personKey(member).role).filter(Boolean), ...credits.map(credit => credit.role)])].sort(personText);
  return {
    id,
    formerIds: keyIds.slice(1),
    memberIds: [...memberIds].sort(personText),
    roles,
    externalIds,
    original,
    preferred,
    nameConflicts,
    aliases: aliases.sort((a, b) => personText(a.value, b.value)),
    links,
    credits
  };
}
