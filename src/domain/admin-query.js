const FILM_QUEUES = new Set([
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
]);
const PERSON_QUEUES = new Set([
  'localization-missing',
  'localization-provisional',
  'localization-conflict',
  'external-id-conflict',
]);

function failure(error) {
  return {error, pin: null};
}

function fold(value) {
  return String(value ?? '')
    .replace(/\p{Script=Latin}+/gu, chunk => chunk.normalize('NFD').replace(/\p{M}+/gu, ''))
    .replace(/ё/gi, 'е')
    .toLocaleLowerCase('ru')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function limitOf(options) {
  const limit = options?.limit;
  return Number.isInteger(limit) && limit >= 1 && limit <= 25 ? limit : null;
}

function values(list, read) {
  const fields = [];
  for (const item of list || []) {
    const folded = fold(read(item));
    if (folded) fields.push(folded);
  }
  return fields;
}

function searchFields(record, kind) {
  const preferred = fold(record?.preferred);
  const originals = kind === 'film'
    ? [fold(record?.originalTitle), fold(record?.epgTitle)].filter(Boolean)
    : [fold(record?.original)].filter(Boolean);
  const aliases = values(record?.aliases, item => item?.value ?? item);
  const externalIds = values(record?.externalIds, item => item?.value ?? item);
  return {preferred, originals, aliases, externalIds};
}

function tokenRank(token, fields) {
  let best = null;
  const consider = rank => {
    if (best === null || rank < best) best = rank;
  };
  for (const value of fields.externalIds) {
    if (value === token) consider(0);
    else if (value.startsWith(token)) consider(3);
    else if (value.includes(token)) consider(4);
  }
  if (fields.preferred) {
    if (fields.preferred === token) consider(1);
    else if (fields.preferred.startsWith(token)) consider(3);
    else if (fields.preferred.includes(token)) consider(4);
  }
  for (const value of [...fields.originals, ...fields.aliases]) {
    if (value === token) consider(2);
    else if (value.startsWith(token)) consider(3);
    else if (value.includes(token)) consider(4);
  }
  return best;
}

function matchRank(record, kind, normalized, tokens) {
  const fields = searchFields(record, kind);
  if (fields.externalIds.includes(normalized)) return 0;
  if (fields.preferred && fields.preferred === normalized) return 1;
  if (fields.originals.includes(normalized) || fields.aliases.includes(normalized)) return 2;
  let worst = -1;
  for (const token of tokens) {
    const rank = tokenRank(token, fields);
    if (rank === null) return null;
    if (rank > worst) worst = rank;
  }
  return worst;
}

function byId(left, right) {
  return String(left.id ?? '').localeCompare(String(right.id ?? ''), 'en');
}

function queueMatch(record, queue) {
  if (queue === 'localization-missing') return record?.localization?.status === 'missing';
  if (queue === 'localization-provisional') return record?.localization?.status === 'provisional';
  if (queue === 'localization-conflict') return (record?.localizationConflicts?.length || 0) > 0;
  if (queue === 'identity-unresolved') return record?.identity?.status === 'unresolved';
  if (queue === 'identity-ambiguous') return record?.identity?.status === 'ambiguous';
  if (queue === 'identity-rejected') return record?.identity?.status === 'rejected';
  if (queue === 'metadata-missing') return record?.metadata?.status === 'missing';
  if (queue === 'metadata-stale') return record?.metadata?.status === 'stale';
  if (queue === 'metadata-failed') return record?.metadata?.status === 'failed';
  if (queue === 'fingerprint-not-current') return record?.fingerprint?.status !== 'current';
  if (queue === 'prediction-not-current') return record?.prediction?.status !== 'current';
  if (queue === 'external-id-conflict') return (record?.externalIds || []).some(item => item?.conflicting === true);
  return false;
}

function rotr(value, bits) {
  return (value >>> bits) | (value << (32 - bits));
}

const SHA_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256(text) {
  const data = new TextEncoder().encode(text);
  const padded = new Uint8Array(((data.length + 9 + 63) & ~63));
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bits = data.length * 8;
  view.setUint32(padded.length - 8, Math.floor(bits / 0x100000000));
  view.setUint32(padded.length - 4, bits >>> 0);
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const words = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(words[i - 15], 7) ^ rotr(words[i - 15], 18) ^ (words[i - 15] >>> 3);
      const s1 = rotr(words[i - 2], 17) ^ rotr(words[i - 2], 19) ^ (words[i - 2] >>> 10);
      words[i] = (words[i - 16] + s0 + words[i - 7] + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choice = (e & f) ^ (~e & g);
      const first = (h + s1 + choice + SHA_K[i] + words[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const second = (s0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + first) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (first + second) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map(word => word.toString(16).padStart(8, '0')).join('');
}

function snapshotDigest(records) {
  return sha256(JSON.stringify(records));
}

function encodeCursor(payload) {
  const binary = Array.from(new TextEncoder().encode(JSON.stringify(payload)), byte => String.fromCharCode(byte)).join('');
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

function decodeCursor(cursor) {
  if (typeof cursor !== 'string' || cursor.length === 0) return null;
  try {
    const padded = cursor.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - cursor.length % 4) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(bytes));
    if (payload?.v !== 1 || typeof payload.op !== 'string' || typeof payload.digest !== 'string' || !Number.isInteger(payload.index) || payload.index < 0) return null;
    return payload;
  } catch {
    return null;
  }
}

function page(records, options, spec) {
  if (!Array.isArray(records)) return failure('invalid_records');
  const limit = limitOf(options);
  if (limit === null) return failure('invalid_limit');
  const selected = spec.select(records);
  if (selected?.error) return failure(selected.error);
  let digest;
  try {
    digest = snapshotDigest(records);
  } catch {
    return failure('invalid_records');
  }
  let start = 0;
  if (options.cursor !== undefined && options.cursor !== null) {
    const payload = decodeCursor(options.cursor);
    const current = selected.rows[payload?.index];
    if (!payload || payload.op !== spec.op || payload.key !== selected.key || payload.limit !== limit || payload.digest !== digest || current?.id !== payload.id) return failure('stale_cursor');
    start = payload.index + 1;
  }
  const slice = selected.rows.slice(start, start + limit);
  const last = start + slice.length - 1;
  const next = selected.rows[last + 1];
  return {
    pin: null,
    items: slice,
    nextCursor: next ? encodeCursor({v: 1, op: spec.op, key: selected.key, limit, digest, index: last, id: selected.rows[last].id}) : null,
  };
}

function search(records, options, kind, op) {
  const normalized = fold(options?.query);
  const tokens = normalized ? normalized.split(' ') : [];
  if (typeof options?.query !== 'string' || tokens.length === 0) {
    return page(records, options, {op, select: () => ({error: 'invalid_query'})});
  }
  return page(records, options, {
    op,
    select() {
      const rows = [];
      records.forEach((record, index) => {
        if (!record || typeof record !== 'object') return;
        const rank = matchRank(record, kind, normalized, tokens);
        if (rank === null) return;
        rows.push({record, rank, index});
      });
      rows.sort((left, right) => left.rank - right.rank || byId(left.record, right.record) || left.index - right.index);
      const titles = new Map();
      for (const row of rows) {
        const title = fold(row.record.preferred);
        if (!title) continue;
        titles.set(title, (titles.get(title) || 0) + 1);
      }
      return {
        key: normalized,
        rows: rows.map(row => {
          const title = fold(row.record.preferred);
          return {...row.record, rank: row.rank, collision: Boolean(title) && titles.get(title) > 1};
        }),
      };
    },
  });
}

function queue(records, options, allowed, op) {
  const code = options?.queue;
  if (typeof code !== 'string' || !allowed.has(code)) {
    return page(records, options, {op, select: () => ({error: 'unknown_queue'})});
  }
  return page(records, options, {
    op,
    select() {
      const rows = records.filter(record => record && typeof record === 'object' && queueMatch(record, code)).sort(byId).map(record => ({...record}));
      return {key: code, rows};
    },
  });
}

export function searchFilms(records, options) {
  return search(records, options, 'film', 'film-search');
}

export function searchPeople(records, options) {
  return search(records, options, 'person', 'person-search');
}

export function filmQueue(records, options) {
  return queue(records, options, FILM_QUEUES, 'film-queue');
}

export function personQueue(records, options) {
  return queue(records, options, PERSON_QUEUES, 'person-queue');
}

function queueRecords(records, queue, allowed) {
  if (!Array.isArray(records)) return {error: 'invalid_records'};
  if (typeof queue !== 'string' || !allowed.has(queue)) return {error: 'unknown_queue'};
  return records.filter(record => record && typeof record === 'object' && queueMatch(record, queue)).sort(byId);
}

function queueCounts(records, allowed) {
  if (!Array.isArray(records)) return {error: 'invalid_records'};
  const counts = {};
  for (const code of allowed) counts[code] = 0;
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    for (const code of allowed) if (queueMatch(record, code)) counts[code] += 1;
  }
  return counts;
}

export function filmQueueRecords(records, queue) {
  return queueRecords(records, queue, FILM_QUEUES);
}

export function personQueueRecords(records, queue) {
  return queueRecords(records, queue, PERSON_QUEUES);
}

export function filmQueueCounts(records) {
  return queueCounts(records, FILM_QUEUES);
}

export function personQueueCounts(records) {
  return queueCounts(records, PERSON_QUEUES);
}

export function getFilm(records, id) {
  if (!Array.isArray(records)) return null;
  return records.find(record => record?.id === id) ?? null;
}

export function getPerson(records, id) {
  if (!Array.isArray(records)) return null;
  return records.find(record => record?.id === id) ?? null;
}
