// Schema v5 metadataSync clocks (ADR 0070). AIR-537 slice 3: the enrichment projector that wrote `film_sync_state` is retired, so only the
// pure clock helpers and the static boundaries remain. The sync decision still does not read film_sync_state.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {filmChangeKey,filmSyncChangeKey,filmSyncState,metadataForFilmId} from '../src/enrichment-projection.js';

const worker=fs.readFileSync('src/worker.js','utf8');
const begin=worker.slice(worker.indexOf('async function beginSync'),worker.indexOf('async function metadataSync'));
const sync=worker.slice(worker.indexOf('async function metadataSync'),worker.indexOf('async function finishSync'));
const cacheSource=fs.readFileSync('src/metadata-cache.js','utf8');
assert.match(cacheSource,/peopleNamesVersion!==2/);
assert.match(cacheSource,/METADATA_FRESH_MS=30\*86400000/);
assert.match(begin,/MetadataCache\.mergeWatchlistFilm/);
assert.match(begin,/MetadataCache\.metadataPending/);
assert.match(sync,/peopleNamesVersion!==2/);
assert.match(sync,/synopsisFetchedAt/);
assert.match(sync,/MetadataCache\.loadMetadataWorkingSet/);
assert.match(sync,/MetadataCache\.saveMetadataWorkingSet/);
assert.doesNotMatch(begin,/film_sync_state|env\.DB|runD1EnrichmentProjection/);
assert.doesNotMatch(sync,/film_sync_state|env\.DB|runD1EnrichmentProjection/);
assert.doesNotMatch(worker,/film_sync_state/);
assert.doesNotMatch(fs.readFileSync('src/catalog-d1.js','utf8'),/film_sync_state/);
const projectorSource=fs.readFileSync('src/d1-enrichment.js','utf8').split('\n').filter(line=>!line.startsWith('//')).join('\n');
assert.doesNotMatch(projectorSource,/runD1EnrichmentProjection|\bBUCKET\b|film_sync_state\s*\(/,'AIR-537: the retired projector runner and its R2 and sync-clock write arms are gone');

const T='2026-10-28T10:00:00.000Z';
const NOW=Date.parse('2026-10-31T12:00:00.000Z');
const DAY=86400000;
const edge=new Date(NOW-30*DAY).toISOString();
const past=new Date(NOW-30*DAY-1).toISOString();
const entry={film:{id:'film:heat',metadata:{updatedAt:T}},watchlist:true,credits:[],metadata:{updatedAt:T,peopleVersion:1,synopsis:'Synopsis'}};
assert.equal(filmChangeKey(entry,T),filmChangeKey({...entry,sync:filmSyncState({metadataAt:T,peopleNamesVersion:2})},T),'the film change key ignores the sync clocks');
assert.equal(filmSyncState(null),null);
assert.equal(filmSyncState([]),null);
assert.deepEqual(filmSyncState({}),{metadataAt:null,synopsisFetchedAt:null,peopleNamesVersion:null,peopleLocalizedAt:null});
assert.deepEqual(filmSyncState({metadataAt:'',synopsisFetchedAt:edge,peopleNamesVersion:'2',peopleLocalizedAt:null}),{metadataAt:null,synopsisFetchedAt:edge,peopleNamesVersion:null,peopleLocalizedAt:null});
assert.deepEqual(filmSyncState({metadataAt:edge,peopleNamesVersion:0,peopleLocalizedAt:T}),{metadataAt:edge,synopsisFetchedAt:null,peopleNamesVersion:0,peopleLocalizedAt:T});
assert.notEqual(filmSyncChangeKey(filmSyncState({metadataAt:edge})),filmSyncChangeKey(filmSyncState({metadataAt:past})));
assert.equal(filmSyncChangeKey(null),'absent');
assert.notEqual(filmSyncChangeKey(filmSyncState({})),'absent','an unstamped entry is not a missing entry');
assert.equal(filmSyncChangeKey(filmSyncState({metadataAt:edge})),filmSyncChangeKey(filmSyncState({metadataAt:edge})));
assert.equal(metadataForFilmId({heat:{id:'heat',metadataAt:edge}},'film:heat').metadataAt,edge);
assert.equal(metadataForFilmId({tmdb_100:{id:'tmdb_100',metadataAt:edge}},'film:tmdb:100').metadataAt,edge);
assert.equal(metadataForFilmId({heat:{id:'heat',metadataAt:edge}},'film:tmdb:949',['heat']).id,'heat');
assert.equal(metadataForFilmId({heat:{id:'heat'}},'film:orphan'),null);
assert.equal(metadataForFilmId(null,'film:heat'),null);
console.log('metadataSync clocks: the pure clock helpers, the 30-day string boundary and the change keys stay; the Worker sync decision does not read film_sync_state; the retired projector runner and its write arms are gone');
