import {filmQueue, getFilm, getPerson, personQueue, searchFilms, searchPeople} from '../domain/admin-query.js';

export const ADMIN_PAGE_LIMIT = 25;

const FILM_QUEUE_CODES = [
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
const PERSON_QUEUE_CODES = [
  'localization-missing',
  'localization-provisional',
  'localization-conflict',
  'external-id-conflict',
];

export const ADMIN_FILMS = [
  {
    id: 'film:north-bridge',
    preferred: 'Северный мост',
    originalTitle: 'North Bridge',
    epgTitle: 'Северный мост',
    canonicalIdentity: 'tmdb:900001',
    storedId: 'fixture-north-bridge',
    aliases: [
      {kind: 'title', value: 'Мост на севере', provenance: {source: 'dictionary', authority: 'owner'}},
      {kind: 'title', value: 'North Bridge', provenance: {source: 'letterboxd'}},
    ],
    externalIds: [{scheme: 'tmdb', value: '900001', trusted: true, conflicting: false, provenance: {source: 'tmdb'}}],
    identity: {status: 'resolved', provenance: {source: 'tmdb'}},
    localization: {status: 'reviewed', value: 'Северный мост', provenance: {source: 'owner'}},
    localizationConflicts: [],
    metadata: {status: 'fresh'},
    fingerprint: {status: 'current'},
    prediction: {status: 'current'},
  },
  {
    id: 'film:quiet-harbor',
    preferred: 'Тихая гавань',
    originalTitle: 'Quiet Harbor',
    epgTitle: 'Quiet Harbor',
    canonicalIdentity: 'tmdb:900002',
    storedId: 'fixture-quiet-harbor',
    aliases: [{kind: 'title', value: 'Quiet Harbor', provenance: {source: 'epg'}}],
    externalIds: [{scheme: 'tmdb', value: '900002', trusted: true, conflicting: false, provenance: {source: 'tmdb'}}],
    identity: {status: 'resolved', provenance: {source: 'tmdb'}},
    localization: {status: 'provisional', value: 'Тихая гавань', provenance: {source: 'wikidata'}},
    localizationConflicts: [],
    metadata: {status: 'partial'},
    fingerprint: {status: 'missing'},
    prediction: {status: 'missing'},
  },
  {
    id: 'film:double',
    preferred: 'Двойная тень',
    originalTitle: 'Double Shade',
    epgTitle: 'Двойная тень',
    canonicalIdentity: null,
    storedId: 'fixture-double',
    aliases: [
      {kind: 'title', value: 'Тень два', provenance: {source: 'epg'}},
      {kind: 'title', value: 'Double Shade', provenance: {source: 'letterboxd'}},
    ],
    externalIds: [
      {scheme: 'tmdb', value: '900101', trusted: false, conflicting: true, provenance: {source: 'epg'}},
      {scheme: 'tmdb', value: '900102', trusted: false, conflicting: true, provenance: {source: 'letterboxd'}},
    ],
    identity: {status: 'ambiguous', provenance: {source: 'tmdb', note: 'two candidates'}},
    localization: {status: 'missing'},
    localizationConflicts: [{reason: 'unresolved', value: 'Тень'}],
    metadata: {status: 'failed'},
    fingerprint: {status: 'stale'},
    prediction: {status: 'failed'},
  },
  {
    id: 'film:same-east',
    preferred: 'Одинаковый рассвет',
    originalTitle: 'Same Dawn East',
    epgTitle: 'Одинаковый рассвет',
    canonicalIdentity: 'tmdb:900201',
    storedId: 'fixture-same-east',
    aliases: [{kind: 'title', value: 'Same Dawn East', provenance: {source: 'letterboxd'}}],
    externalIds: [{scheme: 'tmdb', value: '900201', trusted: true, conflicting: false, provenance: {source: 'tmdb'}}],
    identity: {status: 'resolved', provenance: {source: 'tmdb'}},
    localization: {status: 'reviewed', value: 'Одинаковый рассвет', provenance: {source: 'owner'}},
    localizationConflicts: [],
    metadata: {status: 'fresh'},
    fingerprint: {status: 'current'},
    prediction: {status: 'current'},
  },
  {
    id: 'film:same-west',
    preferred: 'Одинаковый рассвет',
    originalTitle: 'Same Dawn West',
    epgTitle: 'Одинаковый рассвет',
    canonicalIdentity: 'tmdb:900202',
    storedId: 'fixture-same-west',
    aliases: [{kind: 'title', value: 'Same Dawn West', provenance: {source: 'epg'}}],
    externalIds: [{scheme: 'tmdb', value: '900202', trusted: true, conflicting: false, provenance: {source: 'tmdb'}}],
    identity: {status: 'resolved', provenance: {source: 'tmdb'}},
    localization: {status: 'provisional', value: 'Одинаковый рассвет', provenance: {source: 'wikidata'}},
    localizationConflicts: [],
    metadata: {status: 'stale'},
    fingerprint: {status: 'current'},
    prediction: {status: 'stale'},
  },
  {
    id: 'film:blank-reel',
    preferred: null,
    originalTitle: 'Blank Reel',
    epgTitle: 'Blank Reel',
    canonicalIdentity: null,
    storedId: 'fixture-blank-reel',
    aliases: [],
    externalIds: [],
    identity: {status: 'unresolved', provenance: {source: 'epg'}},
    localization: {status: 'missing'},
    localizationConflicts: [],
    metadata: {status: 'missing'},
    fingerprint: {status: 'missing'},
    prediction: {status: 'missing'},
  },
];

export const ADMIN_PEOPLE = [
  {
    id: 'person:mira',
    roleId: 'role-mira',
    preferred: 'Мира Соль',
    original: 'Mira Sol',
    aliases: [{kind: 'name', value: 'M. Sol', provenance: {source: 'letterboxd'}}],
    externalIds: [{scheme: 'letterboxd-role', value: 'role-mira', trusted: true, conflicting: false, provenance: {source: 'letterboxd'}}],
    identity: {status: 'resolved', provenance: {scope: 'role', dedupe: 'deferred'}},
    localization: {status: 'reviewed', value: 'Мира Соль', provenance: {source: 'owner'}},
    localizationConflicts: [],
  },
  {
    id: 'person:lea',
    roleId: 'role-lea',
    preferred: 'Лея Норд',
    original: 'Lea Nord',
    aliases: [{kind: 'name', value: 'L. Nord', provenance: {source: 'dictionary'}}],
    externalIds: [{scheme: 'letterboxd-role', value: 'role-lea', trusted: true, conflicting: false, provenance: {source: 'letterboxd'}}],
    identity: {status: 'resolved', provenance: {scope: 'role', dedupe: 'deferred'}},
    localization: {status: 'provisional', value: 'Лея Норд', provenance: {source: 'wikidata'}},
    localizationConflicts: [],
  },
  {
    id: 'person:extra',
    roleId: 'role-extra',
    preferred: null,
    original: 'Unnamed Extra',
    aliases: [],
    externalIds: [{scheme: 'letterboxd-role', value: 'role-extra', trusted: false, conflicting: true, provenance: {source: 'letterboxd'}}],
    identity: {status: 'resolved', provenance: {scope: 'role', dedupe: 'deferred'}},
    localization: {status: 'missing'},
    localizationConflicts: [{reason: 'held', value: 'Безымянный'}],
  },
];

function fail(limit, error) {
  return {demo: true, pin: null, limit, mode: 'error', error, query: '', queue: '', kind: 'film', id: '', entity: null, entityMissing: false, filmResults: [], personResults: [], queues: []};
}

function listed(result, queueItems, queryActive) {
  if (!queryActive) return queueItems ? queueItems : [];
  if (!queueItems) return result.items;
  const ids = new Set(queueItems.map(item => item.id));
  return result.items.filter(item => ids.has(item.id));
}

export function loadAdmin(params = new URLSearchParams(), options = {}) {
  const limit = Object.hasOwn(options, 'limit') ? options.limit : ADMIN_PAGE_LIMIT;
  if (params.get('error') === 'unavailable') return {...fail(limit, 'unavailable'), query: params.get('q') ?? '', queue: params.get('queue') ?? '', kind: params.get('kind') === 'person' ? 'person' : 'film', id: params.get('id') ?? ''};
  if (params.get('loading') === '1') return {...fail(limit, null), mode: 'loading'};
  const queues = [];
  for (const code of FILM_QUEUE_CODES) {
    const result = filmQueue(ADMIN_FILMS, {queue: code, limit});
    if (result.error) return fail(limit, result.error);
    queues.push({code, kind: 'film', count: result.items.length});
  }
  for (const code of PERSON_QUEUE_CODES) {
    const result = personQueue(ADMIN_PEOPLE, {queue: code, limit});
    if (result.error) return fail(limit, result.error);
    queues.push({code, kind: 'person', count: result.items.length});
  }
  const query = params.get('q') ?? '';
  const queue = params.get('queue') ?? '';
  const kind = params.get('kind') === 'person' ? 'person' : 'film';
  const id = params.get('id') ?? '';
  const queryActive = query.length > 0;
  let filmSearch = null;
  let personSearch = null;
  if (queryActive) {
    filmSearch = searchFilms(ADMIN_FILMS, {query, limit});
    if (filmSearch.error) return {...fail(limit, filmSearch.error), query, queue, kind, id, queues};
    personSearch = searchPeople(ADMIN_PEOPLE, {query, limit});
    if (personSearch.error) return {...fail(limit, personSearch.error), query, queue, kind, id, queues};
  }
  let filmQueueItems = null;
  let personQueueItems = null;
  if (queue) {
    const filmCode = FILM_QUEUE_CODES.includes(queue);
    const personCode = PERSON_QUEUE_CODES.includes(queue);
    if (!filmCode && !personCode) return {...fail(limit, 'unknown_queue'), query, queue, kind, id, queues};
    if (filmCode) {
      const result = filmQueue(ADMIN_FILMS, {queue, limit});
      if (result.error) return {...fail(limit, result.error), query, queue, kind, id, queues};
      filmQueueItems = result.items;
    }
    if (personCode) {
      const result = personQueue(ADMIN_PEOPLE, {queue, limit});
      if (result.error) return {...fail(limit, result.error), query, queue, kind, id, queues};
      personQueueItems = result.items;
    }
  }
  const filmResults = queryActive || filmQueueItems ? listed(filmSearch, filmQueueItems, queryActive) : [];
  const personResults = queryActive || personQueueItems ? listed(personSearch, personQueueItems, queryActive) : [];
  const entity = id ? (kind === 'person' ? getPerson(ADMIN_PEOPLE, id) : getFilm(ADMIN_FILMS, id)) : null;
  return {
    demo: true,
    pin: null,
    limit,
    mode: 'ready',
    error: null,
    query,
    queue,
    kind,
    id,
    entity,
    entityMissing: Boolean(id) && !entity,
    filmResults,
    personResults,
    queues,
    scope: queryActive || queue ? 'results' : 'overview',
  };
}
