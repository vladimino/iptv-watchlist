import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import {filmQueue, filmQueueCounts, filmQueueRecords, getFilm, getPerson, personQueue, personQueueCounts, personQueueRecords, searchFilms, searchPeople} from '../src/domain/admin-query.js';
import {scoped} from '../scripts/bundle-scope.mjs';

const source = fs.readFileSync('src/domain/admin-query.js', 'utf8');
const sha256 = new Function(`${source.replaceAll('export function', 'function')}\nreturn sha256;`)();
for (const sample of ['', 'abc', 'ёжик', 'a'.repeat(80)]) {
  assert.equal(sha256(sample), createHash('sha256').update(sample).digest('hex'), sample);
}
const buildSource = fs.readFileSync('build.mjs', 'utf8');
// The Worker script receives the library only as the AdminQuery namespace: none of its helpers becomes a global there.
const workerBundle = buildSource.slice(buildSource.indexOf("fs.writeFileSync('dist/server/index.js'"));
assert.match(workerBundle, /scoped\('src\/domain\/admin-query\.js','AdminQuery'\)/);
assert.equal(workerBundle.includes("fs.readFileSync('src/domain/admin-query.js','utf8')+"), false);
const scopedSource = scoped('src/domain/admin-query.js', 'AdminQuery');
const namespace = new Function(`${scopedSource}\nreturn AdminQuery;`)();
assert.deepEqual(Object.keys(namespace).sort(), Object.keys(await import('../src/domain/admin-query.js')).sort(), 'the namespace lists every export of the module');
assert.match(scopedSource, /^const AdminQuery=\(\(\)=>\{/);
assert.doesNotMatch(scopedSource, /^export /m);
assert.equal(fs.readFileSync('public/app.js', 'utf8').includes('admin-query'), false);
assert.doesNotMatch(source, /\bfetch\b|BUCKET|cloudflare:|node:fs|film-person-reader|R2|D1/);

function hasNoItems(result) {
  assert.equal(result.pin, null);
  assert.equal(Object.hasOwn(result, 'items'), false);
  assert.equal(Object.hasOwn(result, 'nextCursor'), false);
}

const ranks = [
  {id: 'film:z', preferred: 'Zebra', externalIds: [{scheme: 'tmdb', value: 'needle', trusted: true}]},
  {id: 'film:m', preferred: 'Middle', aliases: [{kind: 'title', value: 'needle'}]},
  {id: 'film:d', preferred: 'Delta', originalTitle: 'needle'},
  {id: 'film:a', preferred: 'needle', synopsis: 'unrelated'},
  {id: 'film:b', preferred: 'needlepoint'},
  {id: 'film:c', preferred: 'Case', originalTitle: 'the needle case', epgTitle: 'schedule only'},
];
const ranked = searchFilms(ranks, {query: 'needle', limit: 25});
assert.equal(ranked.pin, null);
assert.equal(ranked.nextCursor, null);
assert.deepEqual(ranked.items.map(item => [item.id, item.rank, item.collision]), [
  ['film:z', 0, false],
  ['film:a', 1, false],
  ['film:d', 2, false],
  ['film:m', 2, false],
  ['film:b', 3, false],
  ['film:c', 4, false],
]);
assert.equal(ranks[3].rank, undefined, 'search does not mutate the caller record');
assert.equal(ranked.items[1].synopsis, 'unrelated');
assert.equal(searchFilms([{id: 'film:plot', preferred: 'Quiet', synopsis: 'needle'}], {query: 'needle', limit: 5}).items.length, 0);
assert.equal(searchFilms([{id: 'film:epg', preferred: 'Quiet', epgTitle: 'needle'}], {query: 'needle', limit: 5}).items[0].rank, 2);
assert.equal(searchFilms([{id: 'film:both', preferred: 'needle', externalIds: [{value: 'needle'}]}], {query: 'needle', limit: 5}).items[0].rank, 0);
assert.equal(searchFilms(ranks, {query: 'nee', limit: 5}).items.find(item => item.id === 'film:a').rank, 3);
assert.equal(searchFilms(ranks, {query: 'eedle', limit: 5}).items.find(item => item.id === 'film:a').rank, 4);

const folded = searchFilms([
  {id: 'film:yo', preferred: 'Ёжик'},
  {id: 'film:cafe', originalTitle: 'Café'},
  {id: 'film:case', preferred: 'ПОБЕГ'},
], {query: '  ёжик  ', limit: 5});
assert.deepEqual(folded.items.map(item => item.id), ['film:yo']);
assert.equal(searchFilms([{id: 'film:yo', preferred: 'ежик'}], {query: 'Ёжик', limit: 1}).items[0].id, 'film:yo');
assert.equal(searchFilms([{id: 'film:cafe', originalTitle: 'Café'}], {query: 'cafe', limit: 1}).items[0].id, 'film:cafe');
assert.equal(searchFilms([{id: 'film:case', preferred: 'Побег'}], {query: 'ПОБЕГ', limit: 1}).items[0].id, 'film:case');

const split = searchFilms([
  {id: 'film:b', preferred: 'red room', canonicalIdentity: 'tmdb:1'},
  {id: 'film:a', preferred: 'red', aliases: ['room'], canonicalIdentity: 'tmdb:2'},
  {id: 'film:c', preferred: 'red door'},
], {query: 'red room', limit: 10});
assert.deepEqual(split.items.map(item => [item.id, item.rank, item.canonicalIdentity]), [
  ['film:b', 1, 'tmdb:1'],
  ['film:a', 2, 'tmdb:2'],
]);

const collisions = [
  {id: 'film:2', preferred: 'Same', canonicalIdentity: 'tmdb:2'},
  {id: 'film:1', preferred: 'ёж', canonicalIdentity: 'tmdb:1'},
  {id: 'film:3', preferred: 'Еж', canonicalIdentity: null},
  {id: 'film:4', preferred: null},
  {id: 'film:5', preferred: ''},
];
const firstCollision = searchFilms(collisions, {query: 'еж', limit: 1});
assert.equal(firstCollision.items.length, 1);
assert.equal(firstCollision.items[0].collision, true);
assert.notEqual(firstCollision.items[0], collisions.find(record => record.id === firstCollision.items[0].id));
const collisionPage = searchFilms(collisions, {query: 'еж', limit: 1, cursor: firstCollision.nextCursor});
assert.equal(collisionPage.items[0].collision, true);
assert.deepEqual([firstCollision.items[0].id, collisionPage.items[0].id].sort(), ['film:1', 'film:3']);
assert.equal(collisionPage.nextCursor, null);
const sameTitle = searchFilms(collisions, {query: 'same', limit: 5});
assert.equal(sameTitle.items.length, 1);
assert.equal(sameTitle.items[0].collision, false);

const people = [
  {id: 'person:b', roleId: 'role-b', preferred: 'Анна', original: 'Café', aliases: [{kind: 'name', value: 'Anya'}]},
  {id: 'person:a', roleId: 'needle', preferred: 'Other', original: 'Ann', externalIds: [{scheme: 'letterboxd-role', value: 'needle'}]},
];
assert.equal(searchPeople(people, {query: 'cafe', limit: 5}).items[0].id, 'person:b');
assert.equal(searchPeople(people, {query: 'anya', limit: 5}).items[0].rank, 2);
assert.equal(searchPeople(people, {query: 'needle', limit: 5}).items[0].rank, 0);
assert.equal(searchPeople(people, {query: 'role-b', limit: 5}).items.length, 0);
assert.equal(searchPeople([{id: 'person:t', originalTitle: 'Hidden', original: 'Shown'}], {query: 'hidden', limit: 5}).items.length, 0);
const personCollision = searchPeople([
  {id: 'person:2', preferred: 'Имя'},
  {id: 'person:1', preferred: 'имя'},
], {query: 'имя', limit: 5});
assert.deepEqual(personCollision.items.map(item => item.collision), [true, true]);

assert.deepEqual(searchFilms([], {query: 'needle', limit: 25}), {pin: null, items: [], nextCursor: null});
for (const [query, limit] of [['', 5], ['   ', 5], ['!!!', 5], [null, 5]]) {
  hasNoItems(searchFilms(ranks, {query, limit}));
  assert.equal(searchFilms(ranks, {query, limit}).error, 'invalid_query');
}
hasNoItems(searchFilms(ranks, {limit: 5}));
assert.equal(searchFilms([{id: 'film:1', preferred: 'All'}], {query: '', limit: 5}).error, 'invalid_query');
for (const limit of [undefined, 0, 26, 1.5, '25', true]) {
  hasNoItems(searchFilms(ranks, {query: 'needle', limit}));
  assert.equal(searchFilms(ranks, {query: 'needle', limit}).error, 'invalid_limit');
}
assert.equal(searchFilms(ranks, {}).error, 'invalid_limit');
assert.equal(searchFilms(null, {query: 'needle', limit: 5}).error, 'invalid_records');

const many = Array.from({length: 26}, (_, index) => ({id: `film:${String(index).padStart(2, '0')}`, preferred: 'Page'}));
const wide = searchFilms(many, {query: 'page', limit: 25});
assert.equal(wide.items.length, 25);
assert.equal(wide.items[0].id, 'film:00');
assert.equal(wide.items[24].id, 'film:24');
assert.equal(typeof wide.nextCursor, 'string');
const rest = searchFilms(many, {query: 'page', limit: 25, cursor: wide.nextCursor});
assert.deepEqual(rest.items.map(item => item.id), ['film:25']);
assert.equal(rest.nextCursor, null);
assert.deepEqual(searchFilms(many, {query: 'page', limit: 25, cursor: wide.nextCursor}), rest);
const narrow = searchFilms(many, {query: 'page', limit: 1});
assert.deepEqual(narrow.items.map(item => item.id), ['film:00']);
hasNoItems(searchFilms(many, {query: 'page', limit: 2, cursor: narrow.nextCursor}));
assert.equal(searchFilms(many, {query: 'page', limit: 2, cursor: narrow.nextCursor}).error, 'stale_cursor');
hasNoItems(searchFilms(many, {query: 'pages', limit: 1, cursor: narrow.nextCursor}));
hasNoItems(searchFilms(many, {query: 'page', limit: 1, cursor: '@@@'}));
const changed = many.map(record => ({...record, storedId: 'other'}));
hasNoItems(searchFilms(changed, {query: 'page', limit: 1, cursor: narrow.nextCursor}));
const reorderedKeys = many.map(record => ({preferred: record.preferred, id: record.id}));
hasNoItems(searchFilms(reorderedKeys, {query: 'page', limit: 1, cursor: narrow.nextCursor}));
assert.equal(searchFilms(changed, {query: 'page', limit: 1, cursor: narrow.nextCursor}).error, 'stale_cursor');
hasNoItems(searchPeople(people, {query: 'cafe', limit: 1, cursor: narrow.nextCursor}));

const queueFilms = [
  {id: 'film:reviewed', localization: {status: 'reviewed'}, identity: {status: 'resolving'}, metadata: {status: 'fresh'}, fingerprint: {status: 'current'}, prediction: {status: 'current'}, externalIds: [{value: '1', conflicting: false}], localizationConflicts: []},
  {id: 'film:localization-missing', localization: {status: 'missing'}},
  {id: 'film:localization-provisional', localization: {status: 'provisional'}},
  {id: 'film:localization-conflict', localization: {status: 'reviewed'}, localizationConflicts: [{reason: 'owner_kept', value: 'Held'}]},
  {id: 'film:identity-unresolved', identity: {status: 'unresolved'}},
  {id: 'film:identity-ambiguous', identity: {status: 'ambiguous'}},
  {id: 'film:identity-rejected', identity: {status: 'rejected'}},
  {id: 'film:metadata-missing', metadata: {status: 'missing'}},
  {id: 'film:metadata-stale', metadata: {status: 'stale'}},
  {id: 'film:metadata-failed', metadata: {status: 'failed'}},
  {id: 'film:fingerprint-not-current', fingerprint: {status: 'stale'}},
  {id: 'film:fingerprint-missing'},
  {id: 'film:prediction-not-current', prediction: {status: 'failed'}},
  {id: 'film:external-id-conflict', externalIds: [{value: '9', conflicting: true}]},
];
const filmCodes = [
  'localization-missing',
  'localization-provisional',
  'localization-conflict',
  'identity-unresolved',
  'identity-ambiguous',
  'identity-rejected',
  'metadata-missing',
  'metadata-stale',
  'metadata-failed',
  'fingerprint-not-current',
  'prediction-not-current',
  'external-id-conflict',
];
for (const code of filmCodes) {
  const page = filmQueue(queueFilms, {queue: code, limit: 25});
  assert.equal(page.pin, null, code);
  assert.equal(page.items.some(item => item.id === 'film:reviewed'), false, code);
  assert.equal(page.items.some(item => item.id === `film:${code}`), true, code);
  assert.equal(page.items.every(item => item.rank === undefined && item.collision === undefined), true, code);
  assert.notEqual(page.items[0], queueFilms.find(record => record.id === page.items[0].id));
}
const fingerprintQueue = filmQueue(queueFilms, {queue: 'fingerprint-not-current', limit: 25});
assert.deepEqual(fingerprintQueue.items.map(item => item.id), queueFilms.filter(record => record.fingerprint?.status !== 'current').map(record => record.id).sort((left, right) => left.localeCompare(right, 'en')));
assert.equal(fingerprintQueue.items.some(item => item.id === 'film:reviewed'), false);
assert.equal(filmQueue(queueFilms, {queue: 'identity-unresolved', limit: 25}).items.some(item => item.identity?.status === 'resolving'), false);
assert.equal(filmQueue(queueFilms, {queue: 'nope', limit: 5}).error, 'unknown_queue');
hasNoItems(filmQueue(queueFilms, {queue: 'nope', limit: 5}));
assert.equal(filmQueue(queueFilms, {limit: 5}).error, 'unknown_queue');
assert.equal(filmQueue(queueFilms, {queue: 'localization-missing'}).error, 'invalid_limit');

const queuePeople = [
  {id: 'person:ok', localization: {status: 'reviewed'}, externalIds: [{value: '1', conflicting: false}], localizationConflicts: []},
  {id: 'person:localization-missing', localization: {status: 'missing'}},
  {id: 'person:localization-provisional', localization: {status: 'provisional'}},
  {id: 'person:localization-conflict', localizationConflicts: [{reason: 'held'}]},
  {id: 'person:external-id-conflict', externalIds: [{value: '2', conflicting: true}]},
  {id: 'person:b', localization: {status: 'missing'}},
];
for (const code of ['localization-missing', 'localization-provisional', 'localization-conflict', 'external-id-conflict']) {
  const page = personQueue(queuePeople, {queue: code, limit: 25});
  assert.equal(page.items.some(item => item.id === `person:${code}`), true, code);
  assert.equal(page.items.some(item => item.id === 'person:ok'), false, code);
}
assert.deepEqual(personQueue(queuePeople, {queue: 'localization-missing', limit: 25}).items.map(item => item.id), ['person:b', 'person:localization-missing']);
assert.equal(personQueue(queuePeople, {queue: 'identity-unresolved', limit: 5}).error, 'unknown_queue');
assert.equal(personQueue(queuePeople, {queue: 'fingerprint-not-current', limit: 5}).error, 'unknown_queue');
const personPage = personQueue(queuePeople, {queue: 'localization-missing', limit: 1});
assert.equal(personPage.items[0].id, 'person:b');
assert.equal(personQueue(queuePeople, {queue: 'localization-missing', limit: 1, cursor: personPage.nextCursor}).items[0].id, 'person:localization-missing');
hasNoItems(personQueue(queuePeople, {queue: 'localization-provisional', limit: 1, cursor: personPage.nextCursor}));
hasNoItems(filmQueue(queueFilms, {queue: 'localization-missing', limit: 1, cursor: personPage.nextCursor}));

const stored = {id: 'film:1', preferred: 'Kept', redirects: [{to: 'film:2'}], storedId: 'lid'};
assert.equal(getFilm([stored], 'film:1'), stored);
assert.equal(getFilm([stored], 'film:2'), null);
assert.equal(getFilm(null, 'film:1'), null);
const person = {id: 'person:1', roleId: 'role-1', original: 'Ann'};
assert.equal(getPerson([person], 'person:1'), person);
assert.equal(getPerson([person], 'role-1'), null);

const exact = searchFilms([{id: 'film:1', preferred: 'Page'}], {query: 'page', limit: 1});
assert.equal(exact.nextCursor, null);
assert.equal(searchFilms(many, {query: 'page', limit: 25}).items.length, 25);

// Queue counts and queue record sets: the same rules as the pages, without a page.
const counted = [
  {id: 'film:1', localization: {status: 'missing'}, identity: {status: 'unresolved'}, metadata: {status: 'missing'}, fingerprint: {status: 'current'}, prediction: {status: 'current'}, externalIds: []},
  {id: 'film:0', localization: {status: 'provisional'}, localizationConflicts: [{value: 'x'}], identity: {status: 'ambiguous'}, metadata: {status: 'stale'}, fingerprint: {status: 'stale'}, externalIds: [{conflicting: true}]},
  null,
  'text',
  {id: 'film:2', localization: {status: 'reviewed'}, identity: {status: 'rejected'}, metadata: {status: 'failed'}, prediction: {status: 'current'}},
];
assert.deepEqual(filmQueueCounts(counted), {
  'localization-missing': 1, 'localization-provisional': 1, 'localization-conflict': 1,
  'identity-unresolved': 1, 'identity-ambiguous': 1, 'identity-rejected': 1,
  'metadata-missing': 1, 'metadata-stale': 1, 'metadata-failed': 1,
  'fingerprint-not-current': 2, 'prediction-not-current': 1, 'external-id-conflict': 1,
});
assert.deepEqual(personQueueCounts(counted), {'localization-missing': 1, 'localization-provisional': 1, 'localization-conflict': 1, 'external-id-conflict': 1});
assert.deepEqual(filmQueueCounts([]), Object.fromEntries(Object.keys(filmQueueCounts(counted)).map(code => [code, 0])));
assert.equal(filmQueueCounts(null).error, 'invalid_records');
assert.equal(personQueueCounts('x').error, 'invalid_records');
assert.deepEqual(filmQueueRecords(counted, 'fingerprint-not-current').map(record => record.id), ['film:0', 'film:2'], 'id order, non-objects skipped');
assert.deepEqual(filmQueueRecords(counted, 'identity-rejected').map(record => record.id), ['film:2']);
assert.deepEqual(personQueueRecords(counted, 'external-id-conflict').map(record => record.id), ['film:0']);
assert.deepEqual(filmQueueRecords(counted, 'metadata-fresh'), {error: 'unknown_queue'});
assert.deepEqual(personQueueRecords(counted, 'identity-rejected'), {error: 'unknown_queue'});
assert.deepEqual(filmQueueRecords(undefined, 'identity-rejected'), {error: 'invalid_records'});
assert.equal(filmQueueRecords(counted, 'identity-rejected')[0], counted[4], 'records are the caller objects, not copies');
const subset = filmQueueRecords(counted, 'fingerprint-not-current');
const subsetPage = filmQueue(subset, {queue: 'fingerprint-not-current', limit: 25});
assert.deepEqual(subsetPage.items.map(record => record.id), subset.map(record => record.id), 'a page over the subset lists the same records');

console.log('Admin query: ranks, folding, collisions, queues, cursors and limit bounds passed');
