// POST /api/admin/films/<storedId>/title-review: one owner title, conditional write of admin/owner-reviews.json,
// replay, a conflicting requestId, a stale screen token, and the title on the programme, watchlist and admin reads.
// The published programme, the dictionaries and D1 are not written. A GET does not write.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {scoped} from '../scripts/bundle-scope.mjs';

const routeSource = fs.readFileSync('src/admin/film-title-route.js', 'utf8');
assert.match(routeSource, /etagMatches/);
assert.match(routeSource, /etagDoesNotMatch:'\*'/);
assert.doesNotMatch(routeSource, /programme\.json|titles\.json|people\.json|published-generation|\.prepare\(|waitUntil|D1/);
assert.match(fs.readFileSync('src/worker.js', 'utf8'), /pathname\.endsWith\('\/title-review'\)\)return await filmTitleReviewRoute/);

const OVERLAY = 'admin/owner-reviews.json';
const ORIGIN = 'https://iptv.example';
const POINTER = 'epg/published-generation.json';
const G1 = '11111111-1111-4111-8111-111111111111';
const programmeKey = 'epg/generations/' + G1 + '/programme.json';
const AT = '2026-10-29T10:00:00.000Z';
const DICTIONARY = 'Словарный фильм';
const OWNER = 'Хозяйское название';
const records = new Map(), etags = new Map();
let gets = [], puts = [], failPuts = 0, race = null, corruptReadback = false, overlayGets = 0;
const bucket = {
  async get(key) {
    gets.push(key);
    if (key === OVERLAY) overlayGets++;
    if (key === OVERLAY && corruptReadback && overlayGets > 1) return {etag: 'corrupt', uploaded: new Date(AT), json: async () => ({contractVersion: 1, films: {}, people: {}}), text: async () => '{}'};
    if (!records.has(key)) return null;
    const body = records.get(key);
    return {etag: etags.get(key), uploaded: new Date(AT), json: async () => structuredClone(body), text: async () => JSON.stringify(body)};
  },
  async put(key, value, options = {}) {
    puts.push({key, onlyIf: options.onlyIf || null});
    if (!options.onlyIf) throw new Error('title review put must be conditional');
    const current = records.has(key) ? {etag: etags.get(key)} : null;
    if (options.onlyIf.etagMatches && current?.etag !== options.onlyIf.etagMatches) return null;
    if (options.onlyIf.etagDoesNotMatch === '*' && current) return null;
    if (race) {
      const stolen = race;
      race = null;
      records.set(key, stolen);
      etags.set(key, 'stolen');
      return null;
    }
    if (failPuts > 0) { failPuts--; return null; }
    records.set(key, JSON.parse(value));
    etags.set(key, 'e' + (etags.size + puts.length));
    return {etag: etags.get(key)};
  },
  async list() { throw new Error('title review never lists'); },
  async delete() { throw new Error('title review never deletes'); },
};
const env = {BUCKET: bucket};
const context = vm.createContext({Response, Request, Headers, URL, URLSearchParams, AbortSignal, Date, Intl, Map, Set, JSON, TextEncoder, TextDecoder, Uint8Array, Uint32Array, DataView, atob, btoa, crypto: webcrypto, console, setTimeout, structuredClone,
  ASSETS: {}, INITIAL_PERSONAL_RATINGS: {},
  FILM_TITLE_DICTIONARY: [{id: 'd5', tmdbId: '555', original: 'Dict Film', title: DICTIONARY, sources: ['https://www.wikidata.org/wiki/Q1'], aliases: ['Из словаря'], status: 'verified'}],
  PERSON_NAME_DICTIONARY: [],
  fetch: async () => { throw new Error('no outbound request'); }});
for (const file of ['src/domain/film-person.js', 'src/domain/film-title-review.js', 'src/domain/prediction-versions.js', 'src/domain/film-history.js', 'src/domain/prediction-quality.js', 'src/sources.js', 'src/discovery.js', 'src/enrichment.js', 'src/letterboxd-diary.js', 'src/migration-export.js', 'src/filter-presets.js']) vm.runInContext(fs.readFileSync(file, 'utf8'), context);
vm.runInContext(scoped('src/domain/admin-query.js', 'AdminQuery'), context);
vm.runInContext(fs.readFileSync('src/admin/read.js', 'utf8'), context);
vm.runInContext(fs.readFileSync('src/admin/owner-reviews.js', 'utf8'), context);
vm.runInContext(routeSource, context);
vm.runInContext(fs.readFileSync('src/worker.js', 'utf8').replace('export default', 'globalThis.worker='), context);
const worker = context.worker;
const resetCache = () => vm.runInContext('ADMIN_SNAPSHOT_CACHE=null', context);
const execution = {waitUntil() { throw new Error('no background work'); }};

const film = {id: 'd5', tmdbId: '555', title: 'Dict Film', original: 'Dict Film', year: 2001, metadataAt: AT, synopsis: 's', peopleVersion: 1, directors: [], actors: [], shows: [], aliases: ['Прокатное имя', DICTIONARY]};
function seed({overlay = true} = {}) {
  records.clear(); etags.clear(); gets = []; puts = []; failPuts = 0; race = null; corruptReadback = false; overlayGets = 0; resetCache();
  records.set(POINTER, {phase: 'published', programmeRunId: G1, publishedAt: AT}); etags.set(POINTER, 'ptr-1');
  const programme = {runId: G1, updatedAt: AT, watchlistCount: 1, films: [structuredClone(film)], people: {directors: [], actors: []}, stats: {}};
  records.set(programmeKey, programme); etags.set(programmeKey, 'prog-1');
  records.set('programme.json', structuredClone(programme)); etags.set('programme.json', 'root');
  records.set('watchlist.json', {updatedAt: AT, films: [structuredClone(film)]}); etags.set('watchlist.json', 'watch');
  records.set('titles.json', {d5: {tmdbId: '555', title: 'Черновик из кэша', status: 'provisional', sources: ['wikidata']}}); etags.set('titles.json', 'titles-1');
  records.set('people.json', {}); etags.set('people.json', 'people-1');
  if (overlay) {
    records.set(OVERLAY, {contractVersion: 1, films: {}, people: {kept: {name: 'Не трогать'}}});
    etags.set(OVERLAY, 'reviews-0');
  }
}
const snapshotText = key => JSON.stringify(records.get(key));
async function call(path, {method = 'GET', body, headers = {}} = {}) {
  const response = await worker.fetch(new Request(ORIGIN + path, {method, headers, body: body == null ? undefined : JSON.stringify(body)}), env, execution);
  const text = await response.text();
  return {status: response.status, body: text ? JSON.parse(text) : null};
}
function post(path, body, extra = {}) {
  return call(path, {method: 'POST', body, headers: {'Content-Type': 'application/json', Origin: ORIGIN, 'Cf-Access-Jwt-Assertion': 'owner-session', 'X-IPTV-Admin-Action': 'film_title_review', ...extra}});
}
const overlay = () => records.get(OVERLAY);
const audit = () => overlay().films.d5.titleReviews;

seed();
let detail = await call('/api/admin/films/film%3Ad5');
assert.equal(detail.status, 200, JSON.stringify(detail.body));
assert.equal(detail.body.item.preferred, DICTIONARY);
assert.equal(detail.body.item.titleReview.filmId, 'film:d5');
assert.equal(detail.body.item.titleReview.preferred.value, DICTIONARY);
assert.equal(detail.body.item.titleReview.preferred.authority, null, 'a dictionary review is not an owner review');
const options = detail.body.item.titleReview.options;
const dictionaryOption = options.find(option => option.value === 'Из словаря');
const programmeOption = options.find(option => option.value === 'Прокатное имя');
assert.equal(dictionaryOption.origin, 'alias');
assert.equal(dictionaryOption.provenance.source, 'dictionary');
assert.equal(programmeOption.origin, 'alias');
assert.equal(programmeOption.provenance.source, 'programme');
assert.equal(options.filter(option => option.value === DICTIONARY).length, 1, 'the preferred dictionary title is not also an alias choice');
assert.ok(detail.body.item.aliases.some(alias => alias.value === 'Из словаря' && alias.provenance.source === 'dictionary'));
assert.ok(detail.body.item.aliases.some(alias => alias.value === 'Прокатное имя' && alias.provenance.source === 'programme'));
assert.deepEqual(puts, [], 'GET writes nothing');
const version = detail.body.item.titleReview.version;
const pin = detail.body.pin;
assert.match(pin, /^2\|/);
const programmeBefore = snapshotText('programme.json');
const titlesBefore = snapshotText('titles.json');
const peopleBefore = snapshotText('people.json');
const generationBefore = snapshotText(programmeKey);

{
  const denied = await post('/api/admin/films/d5/title-review', {filmId: 'film:d5', requestId: 'req-1', mode: 'manual', value: OWNER, expectedVersion: version}, {'Cf-Access-Jwt-Assertion': '', 'X-IPTV-Admin-Action': 'film_title_review'});
  assert.equal(denied.status, 403);
  const wrongAction = await post('/api/admin/films/d5/title-review', {filmId: 'film:d5', requestId: 'req-1', mode: 'manual', value: OWNER, expectedVersion: version}, {'X-IPTV-Admin-Action': 'person_name_review'});
  assert.equal(wrongAction.status, 403);
  const noOrigin = await call('/api/admin/films/d5/title-review', {method: 'POST', body: {filmId: 'film:d5', requestId: 'req-1', mode: 'manual', value: OWNER, expectedVersion: version}, headers: {'Content-Type': 'application/json', 'Cf-Access-Jwt-Assertion': 'owner-session', 'X-IPTV-Admin-Action': 'film_title_review'}});
  assert.equal(noOrigin.status, 403);
  const otherOrigin = await post('/api/admin/films/d5/title-review', {filmId: 'film:d5', requestId: 'req-1', mode: 'manual', value: OWNER, expectedVersion: version}, {Origin: 'https://elsewhere.example'});
  assert.equal(otherOrigin.status, 403);
  assert.deepEqual(puts, []);
  assert.equal(snapshotText('programme.json'), programmeBefore);
}

{
  const same = await post('/api/admin/films/d5/title-review', {filmId: 'film:d5', requestId: 'req-same', mode: 'alias', value: DICTIONARY, expectedVersion: version});
  assert.equal(same.status, 200, JSON.stringify(same.body));
  assert.equal(same.body.changed, false);
  assert.equal(same.body.ok, true);
  assert.deepEqual(puts, [], 'an already reviewed equal title writes nothing and does not become an owner title');
  const programme = await call('/api/programme');
  assert.equal(programme.body.films[0].title, DICTIONARY);
  assert.equal(programme.body.films[0].titleAuthority, undefined);
}

{
  const missing = await post('/api/admin/films/nope/title-review', {filmId: 'film:nope', requestId: 'req-1', mode: 'manual', value: OWNER, expectedVersion: version});
  assert.equal(missing.status, 404);
  assert.equal(missing.body.reason, 'missing_film');
  const mismatch = await post('/api/admin/films/d5/title-review', {filmId: 'film:other', requestId: 'req-1', mode: 'manual', value: OWNER, expectedVersion: version});
  assert.equal(mismatch.status, 404);
  assert.equal(mismatch.body.reason, 'film_mismatch');
  const identity = await post('/api/admin/films/d5/title-review', {filmId: 'film:d5', requestId: 'req-1', mode: 'manual', value: OWNER, expectedVersion: version, id: 'film:other'});
  assert.equal(identity.status, 400);
  assert.equal(identity.body.reason, 'identity_change_forbidden');
  const stale = await post('/api/admin/films/d5/title-review', {filmId: 'film:d5', requestId: 'req-stale', mode: 'manual', value: OWNER, expectedVersion: 'title-review:1:00000000000000'});
  assert.equal(stale.status, 409);
  assert.equal(stale.body.reason, 'version_conflict');
  assert.equal(stale.body.ok, undefined);
  assert.deepEqual(puts, []);
}

{
  puts = [];
  const written = await post('/api/admin/films/d5/title-review', {filmId: 'film:d5', requestId: 'req-1', mode: 'manual', value: OWNER, expectedVersion: version, basis: 'карточка проката'});
  assert.equal(written.status, 200, JSON.stringify(written.body));
  assert.equal(written.body.ok, true);
  assert.equal(written.body.changed, true);
  assert.equal(written.body.idempotent, false);
  assert.equal(written.body.readback, true);
  assert.equal(written.body.titleReview.preferred.value, OWNER);
  assert.equal(written.body.titleReview.preferred.authority, 'owner');
  assert.equal(audit().length, 1);
  assert.equal(audit()[0].requestId, 'req-1');
  assert.equal(audit()[0].basis, 'карточка проката');
  assert.equal(audit()[0].version.after, written.body.version);
  assert.equal(overlay().people.kept.name, 'Не трогать');
  assert.equal(overlay().films.d5.filmId, 'film:d5');
  assert.deepEqual(puts.map(item => item.key), [OVERLAY]);
  assert.equal(puts[0].onlyIf.etagMatches, 'reviews-0');
  assert.equal(snapshotText('programme.json'), programmeBefore);
  assert.equal(snapshotText('titles.json'), titlesBefore);
  assert.equal(snapshotText('people.json'), peopleBefore);
  assert.equal(snapshotText(programmeKey), generationBefore);
}

{
  const putsBefore = puts.length;
  const replay = await post('/api/admin/films/d5/title-review', {filmId: 'film:d5', requestId: 'req-1', mode: 'manual', value: OWNER, expectedVersion: 'title-review:1:stale', basis: 'карточка проката'});
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.changed, false);
  assert.equal(replay.body.idempotent, true);
  assert.equal(audit().length, 1);
  assert.equal(puts.length, putsBefore, 'a replay does not put');
  const reused = await post('/api/admin/films/d5/title-review', {filmId: 'film:d5', requestId: 'req-1', mode: 'manual', value: 'Другой текст', expectedVersion: version, basis: 'карточка проката'});
  assert.equal(reused.status, 409);
  assert.equal(reused.body.reason, 'request_id_reused');
  assert.equal(reused.body.ok, undefined);
  assert.equal(audit().length, 1);
  assert.equal(puts.length, putsBefore);
}

{
  const again = await call('/api/admin/films/film%3Ad5');
  assert.equal(again.body.item.preferred, OWNER);
  assert.equal(again.body.item.localization.provenance.authority, 'owner');
  assert.equal(again.body.item.titleReview.reviews.length, 1);
  assert.ok(again.body.item.aliases.some(alias => alias.value === DICTIONARY), 'the dictionary title stays an alias');
  const found = await call('/api/admin/films?q=' + encodeURIComponent(OWNER));
  assert.equal(found.body.items.length, 1);
  assert.equal(found.body.items[0].preferred, OWNER);
  const old = await call('/api/admin/films?q=' + encodeURIComponent(DICTIONARY));
  assert.equal(old.body.items.length, 1);
  assert.equal(old.body.items[0].storedId, 'd5');
  const stalePin = await call('/api/admin/overview?pin=' + encodeURIComponent(pin));
  assert.equal(stalePin.status, 409);
  assert.equal(stalePin.body.error, 'stale_pin');
  const oldShape = await call('/api/admin/overview?pin=' + encodeURIComponent('1|' + G1 + '|ptr-1|prog-1|titles-1|people-1'));
  assert.equal(oldShape.status, 400);
  assert.equal(oldShape.body.error, 'invalid_pin');
}

{
  const programme = await call('/api/programme');
  const shown = programme.body.films[0];
  assert.equal(shown.title, OWNER);
  assert.equal(shown.titleRu, OWNER);
  assert.equal(shown.titleAuthority, 'owner');
  assert.equal(shown.titleStatus, 'reviewed');
  assert.equal(shown.titleConflicts[0].value, DICTIONARY);
  assert.equal(shown.titleConflicts[0].reason, 'owner_kept');
  assert.equal(shown.aliases.includes(DICTIONARY), true);
  assert.equal(shown.aliases.includes('Черновик из кэша'), false, 'a provisional cache does not replace the owner title');
  const watch = await call('/api/watchlist');
  assert.equal(watch.body.films[0].title, OWNER);
  assert.equal(watch.body.films[0].titleAuthority, 'owner');
  records.get('programme.json').films[0].title = 'Republished';
  records.get('programme.json').films[0].titleRu = 'Republished';
  const republished = await call('/api/programme');
  assert.equal(republished.body.films[0].title, OWNER);
  assert.equal(republished.body.films[0].titleAuthority, 'owner');
  const ownerEvent = vm.runInContext('eventFilm({id:"d5",tmdbId:"555",title:"' + OWNER + '",titleRu:"' + OWNER + '",titleAuthority:"owner",titleStatus:"reviewed"})', context);
  assert.equal(ownerEvent.title, OWNER, 'an owner title wins over the dictionary on an event row');
  const dictionaryEvent = vm.runInContext('eventFilm({id:"d5",tmdbId:"555",title:"Dict Film",original:"Dict Film"})', context);
  assert.equal(dictionaryEvent.title, DICTIONARY);
}

{
  puts = [];
  failPuts = 1;
  const fresh = await call('/api/admin/films/film%3Ad5');
  const retry = await post('/api/admin/films/d5/title-review', {filmId: 'film:d5', requestId: 'req-2', mode: 'alias', value: 'Dict Film', expectedVersion: fresh.body.item.titleReview.version});
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.changed, true);
  assert.equal(audit().length, 2);
  assert.equal(puts.filter(item => item.key === OVERLAY).length, 2, 'one refused put and one stored put');
  assert.equal(overlay().films.d5.localization.value, 'Dict Film');
}

seed();
{
  puts = [];
  detail = await call('/api/admin/films/film%3Ad5');
  race = {contractVersion: 1, films: {d5: {filmId: 'film:d5', localization: {status: 'reviewed', value: 'Чужая правка', provenance: {authority: 'owner', source: 'owner'}}, aliases: [], titleReviews: [], localizationConflicts: []}}, people: {kept: {name: 'Не трогать'}}};
  const lost = await post('/api/admin/films/d5/title-review', {filmId: 'film:d5', requestId: 'req-race', mode: 'manual', value: OWNER, expectedVersion: detail.body.item.titleReview.version, basis: 'карточка проката'});
  assert.equal(lost.status, 409, JSON.stringify(lost.body));
  assert.equal(lost.body.reason, 'version_conflict');
  assert.equal(overlay().films.d5.localization.value, 'Чужая правка');
  assert.equal(JSON.stringify(overlay()).includes(OWNER), false);
  const reloaded = await call('/api/admin/films/film%3Ad5');
  assert.equal(reloaded.body.item.preferred, 'Чужая правка');
}

seed({overlay: false});
{
  puts = [];
  detail = await call('/api/admin/films/film%3Ad5');
  const created = await post('/api/admin/films/d5/title-review', {filmId: 'film:d5', requestId: 'req-create', mode: 'manual', value: OWNER, expectedVersion: detail.body.item.titleReview.version});
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(puts[0].onlyIf.etagDoesNotMatch, '*');
  assert.equal(overlay().contractVersion, 1);
  assert.deepEqual(overlay().people, {});
  assert.equal(overlay().films.d5.localization.value, OWNER);
  const programme = await call('/api/programme');
  assert.equal(programme.body.films[0].title, OWNER);
}

seed();
{
  detail = await call('/api/admin/films/film%3Ad5');
  corruptReadback = true;
  overlayGets = 0;
  const failed = await post('/api/admin/films/d5/title-review', {filmId: 'film:d5', requestId: 'req-back', mode: 'manual', value: OWNER, expectedVersion: detail.body.item.titleReview.version});
  assert.equal(failed.status, 503, JSON.stringify(failed.body));
  assert.equal(failed.body.reason, 'readback_failed');
  assert.equal(failed.body.ok, undefined);
  corruptReadback = false;
  const seen = await call('/api/admin/films/film%3Ad5');
  assert.equal(seen.body.item.preferred, OWNER, 'a failed readback still stored the title, and the next read shows it');
  assert.equal(seen.body.item.titleReview.reviews.length, 1);
}

seed();
{
  detail = await call('/api/admin/films/film%3Ad5');
  const picked = await post('/api/admin/films/d5/title-review', {filmId: 'film:d5', requestId: 'req-alias-dictionary', mode: 'alias', value: 'Из словаря', expectedVersion: detail.body.item.titleReview.version});
  assert.equal(picked.status, 200, JSON.stringify(picked.body));
  assert.equal(picked.body.changed, true);
  assert.equal(overlay().films.d5.localization.value, 'Из словаря');
  const again = await call('/api/admin/films/film%3Ad5');
  const programmePick = await post('/api/admin/films/d5/title-review', {filmId: 'film:d5', requestId: 'req-alias-programme', mode: 'alias', value: 'Прокатное имя', expectedVersion: again.body.item.titleReview.version});
  assert.equal(programmePick.status, 200, JSON.stringify(programmePick.body));
  assert.equal(programmePick.body.changed, true);
  assert.equal(overlay().films.d5.localization.value, 'Прокатное имя');
  assert.ok(overlay().films.d5.aliases.some(alias => alias.value === 'Из словаря'));
}

console.log('admin film title review: conditional overlay write, replay, conflict, programme and watchlist');
