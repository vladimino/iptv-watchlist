import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {loadLocalCatalog} from '../scripts/local-fixtures.mjs';
import {importFixtures} from '../scripts/local-store.mjs';
import {MemoryBucket} from './memory-bucket.mjs';

const root=path.resolve(path.dirname(new URL(import.meta.url).pathname),'..');
const build=spawnSync(process.execPath,[path.join(root,'build.mjs')],{cwd:root,stdio:'inherit'});
assert.equal(build.status,0);
const worker=await import(pathToFileURL(path.join(root,'dist/server/index.js')).href);
const bucket=new MemoryBucket();
await importFixtures(bucket,await loadLocalCatalog());
const env={BUCKET:bucket};

async function get(pathname){
 const response=await worker.default.fetch(new Request('http://127.0.0.1'+pathname),env);
 assert.equal(response.status,200,pathname);
 return response.json();
}
const programme=await get('/api/programme');
assert.deepEqual(programme.films.map(film=>film.title),['Movie1','Movie2','Movie3']);
const watchlist=await get('/api/watchlist');
assert.deepEqual(watchlist.films.map(film=>film.title),['Movie1','Movie2','Movie3']);
const started=await get('/api/started');
assert.deepEqual(started.ids,['movie-1']);
const view=await get('/api/enrichment/view');
assert.equal(view.films.films,undefined);
assert.equal(view.films['movie-1'].actualRating,4.5);
assert.deepEqual(view.films['movie-1'].moodIds,['tense']);
assert.deepEqual(view.films['movie-1'].fingerprint.plotMechanics,['heist']);
assert.equal(view.films['movie-2'].prediction.predictedRating,4);
assert.equal(view.films['movie-2'].prediction.stale,false);
assert.deepEqual(view.films['movie-2'].moodIds,['light']);
assert.deepEqual(view.films['movie-2'].prediction.moodIds,['light']);
console.log('Local API: programme, started, and enrichment view match the fixture catalog');
