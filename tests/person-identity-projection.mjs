import fs from 'node:fs';
import assert from 'node:assert/strict';
import {PERSON_CROSS_SOURCE, PERSON_IDENTITY_PROJECTION_VERSION, PERSON_REFERENCE_STATES, filmsForPerson, personSurfaces, projectPersonIdentity, resolvePersonReference} from '../src/domain/person-identity-projection.js';

const source = fs.readFileSync('src/domain/person-identity-projection.js', 'utf8');
assert.match(source, /from '\.\/canonical-person\.js'/);
assert.doesNotMatch(source, /\b(fetch|require|BUCKET|wrangler|prepare|Date\.now|new Date|Math\.random)\b/);
for (const file of ['build.mjs', 'src/worker.js', 'src/catalog-d1.js', 'src/d1-enrichment.js', 'src/canonical-repository.js', 'src/enrichment-projection.js', 'public/app.js']) {
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /person-identity-projection|canonical-person/, `${file} does not load the projection`);
}

const plain = value => JSON.parse(JSON.stringify(value));
const freeze = value => {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const item of Object.values(value)) freeze(item);
  }
  return value;
};
const person = (id, original, localization = null) => ({id, original, aliases: [], localization});
const film = (id, surface, verified = true) => ({id, surface, verified});
const credit = (filmId, personId, role = 'actor') => ({filmId, personId, role});
const ref = (projection, id) => projection.references.find(item => item.memberIds.includes(id));
const reverse = list => list.slice().reverse();

assert.equal(PERSON_IDENTITY_PROJECTION_VERSION, 1);
assert.deepEqual(PERSON_REFERENCE_STATES, ['trusted', 'unresolved', 'ambiguous', 'conflicting']);
assert.deepEqual(PERSON_CROSS_SOURCE, ['verified', 'refused', 'ambiguous', 'none']);
assert.deepEqual(plain(projectPersonIdentity()), {version: 1, totals: {references: 0, trusted: 0, unresolved: 0, ambiguous: 0, conflicting: 0}, references: [], issues: []});

// Verified shared Film: one human for the watchlist credit and the catalog credit, one id from every selector.
const shared = freeze({
  persons: [person('person:actor/ann', 'Ann'), person('person:director/ann', 'Ann'), person('person:tmdb_actor/1', 'Ann'), person('person:tmdb_director/1', 'Ann')],
  films: [film('film:watch', 'watchlist'), film('film:catalog', 'catalog'), film('film:directed', 'watchlist')],
  credits: [
    credit('film:watch', 'person:actor/ann'),
    credit('film:watch', 'person:tmdb_actor/1'),
    credit('film:catalog', 'person:tmdb_actor/1'),
    credit('film:directed', 'person:director/ann', 'director'),
    credit('film:directed', 'person:tmdb_director/1', 'director')
  ]
});
{
  const projection = projectPersonIdentity(shared);
  const ann = ref(projection, 'person:tmdb_actor/1');
  assert.equal(ann.humanId, 'human:letterboxd:ann');
  assert.equal(ann.state, 'trusted');
  assert.equal(ann.crossSource, 'verified');
  assert.deepEqual(ann.memberIds, ['person:actor/ann', 'person:director/ann', 'person:tmdb_actor/1', 'person:tmdb_director/1']);
  assert.deepEqual(ann.formerIds, ['human:tmdb:1']);
  assert.deepEqual(ann.externalIds.map(item => [item.scheme, item.value, item.provenance.source]), [['letterboxd_person', 'ann', 'person_record_id'], ['tmdb_person', '1', 'person_record_id']]);
  assert.deepEqual(ann.reversal, {destructive: false, stored: false, formerIds: ['human:tmdb:1'], splits: [{personIds: ['person:actor/ann', 'person:director/ann', 'person:tmdb_actor/1', 'person:tmdb_director/1'], verdict: 'different'}]});
  assert.deepEqual(ann.reviews, []);
  const surfaces = personSurfaces(projection, {recordId: 'person:actor/ann'}, 'actor');
  assert.equal(surfaces.same, true);
  assert.equal(surfaces.humanId, 'human:letterboxd:ann');
  assert.deepEqual(surfaces.watchlist, ['film:watch']);
  assert.deepEqual(surfaces.catalog, ['film:catalog']);
  for (const selector of [{humanId: 'human:letterboxd:ann'}, {humanId: 'human:tmdb:1'}, {recordId: 'person:tmdb_director/1'}, {scheme: 'tmdb_person', value: '1'}, {scheme: 'letterboxd_person', value: 'ann'}]) {
    assert.equal(personSurfaces(projection, selector, 'actor').humanId, 'human:letterboxd:ann', JSON.stringify(selector));
  }
  assert.deepEqual(filmsForPerson(projection, {selector: {humanId: 'human:letterboxd:ann'}, role: 'director'}).films, ['film:directed'], 'a director filter does not return the actor credit');
  assert.deepEqual(filmsForPerson(projection, {selector: {humanId: 'human:letterboxd:ann'}, role: 'actor', surface: 'catalog'}).films, ['film:catalog']);
  assert.deepEqual(plain(projectPersonIdentity(shared)), plain(projection), 'a second projection is the same');
  const shuffled = projectPersonIdentity({persons: reverse(shared.persons), films: reverse(shared.films), credits: reverse(shared.credits)});
  assert.deepEqual(plain(shuffled), plain(projection), 'input order does not change the reference');
  assert.deepEqual(plain(projectPersonIdentity({...shared, credits: [...shared.credits, ...shared.credits]})), plain(projection), 'a repeated credit does not create a second link');
}

// Shared name, remake, different roles, and a Film with two trusted ids: none of these join.
{
  const remake = projectPersonIdentity({
    persons: [person('person:actor/mary-lee', 'Mary Lee'), person('person:tmdb_actor/41', 'Mary Lee')],
    films: [film('film:original', 'watchlist'), film('film:remake', 'catalog')],
    credits: [credit('film:original', 'person:actor/mary-lee'), credit('film:remake', 'person:tmdb_actor/41')]
  });
  const mary = ref(remake, 'person:actor/mary-lee');
  const other = ref(remake, 'person:tmdb_actor/41');
  assert.equal(mary.state, 'ambiguous');
  assert.equal(mary.crossSource, 'none');
  assert.notEqual(mary.humanId, other.humanId);
  assert.deepEqual(mary.reviews.map(review => review.reason), ['name_only']);
  assert.deepEqual(personSurfaces(remake, {recordId: 'person:actor/mary-lee'}, 'actor'), {same: true, status: 'ambiguous', crossSource: 'none', humanId: mary.humanId, watchlist: ['film:original'], catalog: []});
  assert.deepEqual(personSurfaces(remake, {recordId: 'person:tmdb_actor/41'}, 'actor').catalog, ['film:remake']);
  assert.deepEqual(filmsForPerson(remake, {selector: {name: 'Mary Lee'}, role: 'actor'}).films, [], 'a name is not a selector');
}
{
  const roles = projectPersonIdentity({
    persons: [person('person:actor/ann', 'Ann'), person('person:tmdb_director/3', 'Ann')],
    films: [film('film:one', 'watchlist')],
    credits: [credit('film:one', 'person:actor/ann', 'actor'), credit('film:one', 'person:tmdb_director/3', 'director')]
  });
  assert.equal(roles.references.length, 2);
  assert.equal(ref(roles, 'person:actor/ann').state, 'ambiguous');
  assert.deepEqual(filmsForPerson(roles, {selector: {recordId: 'person:actor/ann'}, role: 'director'}).films, []);
  assert.deepEqual(filmsForPerson(roles, {selector: {recordId: 'person:tmdb_director/3'}, role: 'actor'}).films, []);
}
{
  const collision = projectPersonIdentity({
    persons: [person('person:actor/ann', 'Ann'), person('person:tmdb_actor/1', 'Ann')],
    films: [{id: 'film:one', surface: 'watchlist', externalIds: [{scheme: 'tmdb', value: '5', trusted: true}, {scheme: 'tmdb', value: '6', trusted: true}]}],
    credits: [credit('film:one', 'person:actor/ann'), credit('film:one', 'person:tmdb_actor/1')]
  });
  assert.notEqual(ref(collision, 'person:actor/ann').humanId, ref(collision, 'person:tmdb_actor/1').humanId, 'two trusted Film ids are not a shared Film');
  assert.equal(ref(collision, 'person:actor/ann').state, 'ambiguous');
}

// 1:N and namesakes stay separate. The other side's catalog film is not a match.
{
  const many = projectPersonIdentity({
    persons: [person('person:actor/ivan', 'Ivan Petrov'), person('person:tmdb_actor/21', 'Ivan Petrov'), person('person:tmdb_actor/22', 'Ivan Petrov')],
    films: [film('film:shared', 'watchlist'), film('film:only-21', 'catalog')],
    credits: [credit('film:shared', 'person:actor/ivan'), credit('film:shared', 'person:tmdb_actor/21'), credit('film:shared', 'person:tmdb_actor/22'), credit('film:only-21', 'person:tmdb_actor/21')]
  });
  assert.equal(many.totals.ambiguous, 3);
  assert.equal(many.totals.trusted, 0);
  const ivan = personSurfaces(many, {recordId: 'person:actor/ivan'}, 'actor');
  assert.deepEqual(ivan.watchlist, ['film:shared']);
  assert.deepEqual(ivan.catalog, []);
  assert.equal(ivan.status, 'ambiguous');
  assert.equal(ivan.crossSource, 'ambiguous');
  assert.deepEqual(personSurfaces(many, {recordId: 'person:tmdb_actor/21'}, 'actor').catalog, ['film:only-21']);
  assert.notEqual(ivan.humanId, personSurfaces(many, {recordId: 'person:tmdb_actor/21'}, 'actor').humanId);
}
{
  const namesakes = projectPersonIdentity({
    persons: [person('person:actor/john-smith', 'John Smith'), person('person:actor/john-smith-1', 'John Smith')],
    films: [film('film:a', 'watchlist'), film('film:b', 'catalog')],
    credits: [credit('film:a', 'person:actor/john-smith'), credit('film:b', 'person:actor/john-smith-1')]
  });
  assert.equal(ref(namesakes, 'person:actor/john-smith').state, 'ambiguous');
  assert.deepEqual(ref(namesakes, 'person:actor/john-smith').reviews.map(review => review.reason), ['same_name']);
  assert.deepEqual(personSurfaces(namesakes, {scheme: 'letterboxd_person', value: 'john-smith'}, 'actor').catalog, []);
}

// A TV id is a Film identity only. The same number on a person record, with no shared credit, joins nothing.
{
  const show = projectPersonIdentity({
    persons: [person('person:actor/ann', 'Ann'), person('person:tmdb_actor/9', 'Bob')],
    films: [{id: 'film:show', surface: 'catalog', verified: true, canonicalIdentity: 'tmdb_tv:9'}],
    credits: [credit('film:show', 'person:actor/ann')]
  });
  assert.equal(ref(show, 'person:actor/ann').crossSource, 'none');
  assert.equal(ref(show, 'person:tmdb_actor/9').state, 'unresolved');
  assert.notEqual(ref(show, 'person:actor/ann').humanId, ref(show, 'person:tmdb_actor/9').humanId);
}
{
  const credited = projectPersonIdentity({
    persons: [person('person:actor/ann', 'Ann'), person('person:tmdb_actor/9', 'Ann')],
    films: [{id: 'film:show', surface: 'watchlist', externalIds: [{scheme: 'tmdb_tv', value: '9', trusted: true}]}],
    credits: [credit('film:show', 'person:actor/ann'), credit('film:show', 'person:tmdb_actor/9')]
  });
  assert.equal(ref(credited, 'person:tmdb_actor/9').state, 'trusted');
  assert.equal(ref(credited, 'person:tmdb_actor/9').crossSource, 'verified');
}

// Owner `different` splits a verified join and leaves each source key intact. The old id still resolves.
{
  const joined = projectPersonIdentity(shared);
  const split = projectPersonIdentity({...shared, decisions: [{personIds: ['person:actor/ann', 'person:tmdb_actor/1'], verdict: 'different', at: '2026-10-31T00:00:00.000Z', basis: 'not the same'}]});
  const letterboxd = ref(split, 'person:actor/ann');
  const tmdb = ref(split, 'person:tmdb_actor/1');
  assert.notEqual(letterboxd.humanId, tmdb.humanId);
  assert.equal(letterboxd.state, 'trusted', 'the source key still groups the two roles');
  assert.equal(letterboxd.crossSource, 'refused');
  assert.deepEqual(letterboxd.memberIds, ['person:actor/ann', 'person:director/ann']);
  assert.deepEqual(letterboxd.reviews.map(review => review.reason), ['owner_different']);
  assert.deepEqual(personSurfaces(split, {recordId: 'person:actor/ann'}, 'actor').catalog, []);
  assert.deepEqual(personSurfaces(split, {humanId: 'human:tmdb:1'}, 'actor').catalog, ['film:catalog']);
  assert.equal(resolvePersonReference(split, {humanId: joined.references[0].humanId}).humanId, letterboxd.humanId);
  assert.deepEqual(letterboxd.reversal.splits, [], 'a source key is not split by an owner decision');
}
{
  const refused = projectPersonIdentity({
    persons: [person('person:actor/ann', 'Ann'), person('person:tmdb_actor/1', 'Ann')],
    films: [film('film:watch', 'watchlist'), film('film:catalog', 'catalog')],
    credits: [credit('film:watch', 'person:actor/ann'), credit('film:watch', 'person:tmdb_actor/1'), credit('film:catalog', 'person:tmdb_actor/1')],
    decisions: [{personIds: ['person:actor/ann', 'person:tmdb_actor/1'], verdict: 'different', at: '2026-10-31T00:00:00.000Z', basis: 'not the same'}]
  });
  assert.equal(ref(refused, 'person:actor/ann').state, 'conflicting');
  assert.equal(ref(refused, 'person:actor/ann').crossSource, 'refused');
  assert.deepEqual(personSurfaces(refused, {recordId: 'person:actor/ann'}, 'actor').catalog, []);
}

// An owner `same` is trusted. A second Letterboxd key with credits is a collision and stays out of the members.
{
  const owner = projectPersonIdentity({
    persons: [person('person:actor/a-one', 'Alex Grey'), person('person:actor/a-two', 'Alex Grey'), person('person:tmdb_actor/51', 'Alex Grey')],
    films: [film('film:a', 'watchlist'), film('film:catalog', 'catalog')],
    credits: [credit('film:a', 'person:actor/a-two'), credit('film:a', 'person:tmdb_actor/51'), credit('film:catalog', 'person:tmdb_actor/51')],
    decisions: [{personIds: ['person:actor/a-one', 'person:tmdb_actor/51'], verdict: 'same', at: '2026-10-31T00:00:00.000Z', basis: 'owner checked'}]
  });
  const grey = ref(owner, 'person:tmdb_actor/51');
  assert.equal(grey.state, 'trusted');
  assert.equal(grey.crossSource, 'verified');
  assert.deepEqual(grey.memberIds, ['person:actor/a-one', 'person:tmdb_actor/51']);
  assert.equal(ref(owner, 'person:actor/a-two').state, 'conflicting');
  assert.deepEqual(personSurfaces(owner, {recordId: 'person:actor/a-one'}, 'actor').catalog, ['film:catalog']);
  assert.deepEqual(personSurfaces(owner, {recordId: 'person:actor/a-two'}, 'actor').catalog, [], 'the colliding key does not inherit the verified human');
}

// A shared Film with different names links nothing, and a bad selector fails closed.
{
  const apart = projectPersonIdentity({
    persons: [person('person:actor/someone', 'Someone Else'), person('person:tmdb_actor/12', 'Кто-то Другой')],
    films: [film('film:one', 'watchlist'), film('film:catalog', 'catalog')],
    credits: [credit('film:one', 'person:actor/someone'), credit('film:one', 'person:tmdb_actor/12'), credit('film:catalog', 'person:tmdb_actor/12')]
  });
  assert.equal(ref(apart, 'person:actor/someone').state, 'unresolved');
  assert.equal(ref(apart, 'person:tmdb_actor/12').state, 'unresolved');
  assert.deepEqual(personSurfaces(apart, {recordId: 'person:actor/someone'}, 'actor').catalog, []);
  assert.deepEqual(personSurfaces(apart, {recordId: 'person:tmdb_actor/12'}, 'actor').catalog, ['film:catalog']);
  const disagreed = filmsForPerson(apart, {selector: {humanId: ref(apart, 'person:actor/someone').humanId, recordId: 'person:tmdb_actor/12'}, role: 'actor'});
  assert.equal(disagreed.status, 'conflicting');
  assert.equal(disagreed.humanId, null);
  assert.deepEqual(disagreed.films, []);
  assert.equal(filmsForPerson(apart, {selector: {recordId: 'person:missing'}, role: 'writer'}).status, 'unknown');
  assert.equal(resolvePersonReference(apart, {scheme: 'tmdb_person'}).status, 'unknown');
}
{
  const doubled = projectPersonIdentity({
    persons: [person('person:actor/ann', 'Ann')],
    films: [film('film:one', 'watchlist'), {id: 'film:one', surface: 'catalog'}],
    credits: [credit('film:one', 'person:actor/ann')]
  });
  assert.deepEqual(doubled.issues, [{code: 'conflicting_surface', filmId: 'film:one'}]);
  assert.deepEqual(filmsForPerson(doubled, {selector: {recordId: 'person:actor/ann'}, role: 'actor'}).films, ['film:one'], 'an omitted surface still returns the credit');
  assert.deepEqual(personSurfaces(doubled, {recordId: 'person:actor/ann'}, 'actor').watchlist, [], 'a contradicted surface matches neither side');
}

// A reviewed name is kept, and the input record is not rewritten.
{
  const record = person('person:actor/ann', 'Ann', {status: 'reviewed', value: 'Энн', source: 'owner', provenance: {authority: 'owner'}});
  const localization = record.localization;
  const named = projectPersonIdentity({persons: [record], films: [], credits: []});
  assert.equal(named.references[0].preferred.value, 'Энн');
  assert.equal(named.references[0].preferred.authority, 'owner');
  assert.equal(record.localization, localization);
  assert.equal(record.original, 'Ann');
}
