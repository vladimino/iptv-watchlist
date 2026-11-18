// Read-only measurement for the identity work inventory: aggregate counts and sizes under letterboxd/imports/ from ListObjectsV2 only.
// No object body is read (no GetObject, no ZIP), nothing is written, and no key or archive hash is printed. Credentials come from the
// environment (R2_SNAPSHOT_*, see the iptv-credentials skill); only variable names are ever reported.
//   set -a; . ~/.config/iptv/r2-snapshot.env; set +a; NODE_USE_ENV_PROXY=1 node scripts/identity-work-measure.mjs
import {signRequest,parseListing} from './r2-snapshot-export.mjs';

const PREFIX = 'letterboxd/imports/';
const REGISTRY_MAX_BYTES = 256 * 1024, DOC_MAX_BYTES = 2 * 1024 * 1024, LIST_MAX = 1000;
const accountId = process.env.R2_SNAPSHOT_ACCOUNT_ID, accessKeyId = process.env.R2_SNAPSHOT_ACCESS_KEY_ID, secretAccessKey = process.env.R2_SNAPSHOT_SECRET_ACCESS_KEY, bucket = process.env.R2_SNAPSHOT_BUCKET || 'iptv';
const missing = ['R2_SNAPSHOT_ACCOUNT_ID', 'R2_SNAPSHOT_ACCESS_KEY_ID', 'R2_SNAPSHOT_SECRET_ACCESS_KEY'].filter(name => !process.env[name]);
if (missing.length) {console.error('missing: ' + missing.join(', ')); process.exit(2);}
const credentials = {accessKeyId, secretAccessKey, endpoint: 'https://' + accountId + '.r2.cloudflarestorage.com', bucket};

async function list(cursor) {
  const url = new URL(credentials.endpoint + '/' + bucket);
  url.searchParams.set('list-type', '2'); url.searchParams.set('prefix', PREFIX); url.searchParams.set('max-keys', '1000');
  if (cursor) url.searchParams.set('continuation-token', cursor);
  const headers = signRequest({method: 'GET', url, headers: {'Accept-Encoding': 'identity'}, credentials});
  const response = await fetch(url, {method: 'GET', headers, redirect: 'error', cache: 'no-store'});
  if (!response.ok) throw new Error('list failed: HTTP ' + response.status);
  return parseListing(await response.text());
}

const objects = [];
let cursor = null, pages = 0;
do {const page = await list(cursor); objects.push(...page.objects); cursor = page.nextCursor; pages++;} while (cursor);

const archives = new Map();
const kinds = {};
let registry = null;
for (const object of objects) {
  const rest = object.key.slice(PREFIX.length);
  if (rest === 'registry.json') {registry = object.size; continue;}
  const slash = rest.indexOf('/');
  const sha = slash > 0 ? rest.slice(0, slash) : null;
  const name = slash > 0 ? rest.slice(slash + 1) : rest;
  const kind = name === 'rated-candidates.json' ? 'rated-candidates.json' : /^chunks\/\d+\.(intent|receipt|candidates)\.json$/.test(name) ? 'chunks/<n>.' + name.split('.')[1] + '.json' : 'other';
  kinds[kind] = (kinds[kind] || 0) + 1;
  if (!sha) continue;
  const entry = archives.get(sha) || {objects: 0, bytes: 0, doc: null};
  entry.objects++; entry.bytes += object.size;
  if (kind === 'rated-candidates.json') entry.doc = object.size;
  archives.set(sha, entry);
}
const docs = [...archives.values()].map(entry => entry.doc).filter(size => size !== null).sort((a, b) => a - b);
const quantile = p => docs.length ? docs[Math.min(docs.length - 1, Math.floor(p * docs.length))] : null;
const perArchive = [...archives.values()].map(entry => entry.objects).sort((a, b) => a - b);
console.log(JSON.stringify({
  measuredAt: new Date().toISOString(), bucket, prefix: PREFIX, listPages: pages, objects: objects.length,
  archivePrefixes: archives.size, delimiterListFits: archives.size <= LIST_MAX, listCap: LIST_MAX,
  objectsByKind: kinds, registryObject: registry === null ? 'absent' : {bytes: registry},
  archivesWithoutCandidateDocument: [...archives.values()].filter(entry => entry.doc === null).length,
  candidateDocumentBytes: {count: docs.length, min: docs[0] ?? null, median: quantile(0.5), p95: quantile(0.95), max: docs.length ? docs[docs.length - 1] : null, sum: docs.reduce((a, b) => a + b, 0), over2MiB: docs.filter(size => size > DOC_MAX_BYTES).length, cap: DOC_MAX_BYTES},
  objectsPerArchive: {min: perArchive[0] ?? null, median: perArchive.length ? perArchive[Math.floor(perArchive.length / 2)] : null, max: perArchive.length ? perArchive[perArchive.length - 1] : null},
  registryProjection: {archiveCap: 500, byteCap: REGISTRY_MAX_BYTES, estimatedBytesPerRow: 280, estimatedBytesForArchives: archives.size * 280},
}, null, 1));
