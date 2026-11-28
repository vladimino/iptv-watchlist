// AIR-648: the shared Film resolver, aggregate and history run from the REAL Worker bundle (dist/server/index.js built by build.mjs), not only as ES modules.
// An ES-module test cannot see a name a scope fails to receive (it resolves the real import); the bundle can. Here: the scope surface against the offline modules (every export,
// both directions, classes included), the typed invalid error, digest parity and the dormancy of the Worker router. The synthetic READS of the real built scopes, on the same D1 fixtures
// as the offline suites, are in tests/film-aggregate.mjs and tests/film-history-aggregate.mjs ("bundled parity" blocks). Nothing is routed or served.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {loadBundledFilmScopes} from './film-aggregate-bundle-scope.mjs';
import * as offlineResolver from '../src/film-aggregate-resolver.js';
import * as offlineAggregate from '../src/film-aggregate.js';
import * as offlineHistory from '../src/film-history-aggregate.js';
import * as offlineReadiness from '../src/film-readiness.js';
import * as offlineParity from '../src/domain/film-dimension-parity.js';
import * as offlineReader from '../src/film-readiness-reader.js';
import * as offlineComposition from '../src/film-readiness-composition.js';

const {text,worker,Sha256Sync,FilmAggregateResolver,FilmAggregate,FilmReadiness,FilmDimensionParity,FilmReadinessReader,FilmReadinessComposition,FilmHistoryAggregate}=loadBundledFilmScopes();
assert.ok(!/from 'node:|require\(|createHash\(/.test(text),'the bundle names no Node-only module or hash API');

// The scope hands over EXACTLY the offline module's exports: nothing dropped (the class FilmAggregateInvalid once was), nothing extra.
for(const [scope,offline,label] of [[FilmAggregateResolver,offlineResolver,'resolver'],[FilmAggregate,offlineAggregate,'aggregate'],[FilmHistoryAggregate,offlineHistory,'history'],[FilmReadiness,offlineReadiness,'readiness'],[FilmDimensionParity,offlineParity,'dimension parity'],[FilmReadinessReader,offlineReader,'readiness reader'],[FilmReadinessComposition,offlineComposition,'readiness composition']]){
 assert.deepEqual(Object.keys(scope).sort(),Object.keys(offline).sort(),label+' scope exports differ from the offline module');
 for(const name of Object.keys(offline))if(typeof offline[name]!=='function'&&typeof offline[name]!=='object')assert.equal(scope[name],offline[name],label+' '+name);
}
assert.equal(typeof FilmAggregateResolver.FilmAggregateInvalid,'function');
assert.equal(FilmAggregate.FILM_AGGREGATE_ROUTE,offlineAggregate.FILM_AGGREGATE_ROUTE);

// The typed invalid error survives the scope: malformed input raises the bundled class (code 'invalid'), as offline.
for(const bad of ['bad id','tmdb_x','tmdb_tv:0','film:','',null,5]){
 assert.throws(()=>FilmAggregateResolver.parseTypedFilmId(bad),error=>error instanceof FilmAggregateResolver.FilmAggregateInvalid&&error.code==='invalid'&&error.message==='invalid',String(bad));
 assert.throws(()=>offlineResolver.parseTypedFilmId(bad),error=>error instanceof offlineResolver.FilmAggregateInvalid&&error.code==='invalid');
}
assert.deepEqual({...FilmAggregateResolver.parseTypedFilmId('tmdb_5')},{...offlineResolver.parseTypedFilmId('tmdb_5')});

// Digest parity through the bundle: raw text (UTF-8) against node createHash, the identity digest of a real-shaped snapshot against the offline module.
for(const sample of ['','ratings etag Ёлки 🎬','{"a":[1,2,3]}'])assert.equal(Sha256Sync.sha256Hex(sample),crypto.createHash('sha256').update(sample).digest('hex'));
const keys={films:['film_b','film_a'],pairs:[],movies:['m1']};
const snapshot={marker:{generation:2,state:'open'},films:['film_a','film_b'],redirects:[],revisions:[],owned:[],claimed:[],decisions:[]};
const viaBundle=FilmAggregateResolver.identityDigest(JSON.parse(JSON.stringify(keys)),JSON.parse(JSON.stringify(snapshot)));
assert.equal(viaBundle,offlineResolver.identityDigest(keys,snapshot));
assert.match(viaBundle,/^sha256:[0-9a-f]{64}$/);

// Dormancy: the bundled Worker router does not dispatch to the internal route. GET and HEAD, with and without a typed id, never answer the aggregate contract.
for(const method of ['GET','HEAD'])for(const query of ['?id=tmdb_5','']){
 let answer;
 try{answer=await worker.fetch(new Request('https://iptv.test'+offlineAggregate.FILM_AGGREGATE_ROUTE+query,{method}),{});}catch(error){answer=null;}
 if(answer){const body=await answer.text();assert.ok(!body.includes(offlineAggregate.FILM_AGGREGATE_CONTRACT)&&!/"identity"\s*:\s*\{"verdict"/.test(body),method+query+': the router served the aggregate');assert.notEqual(answer.status,200,method+query);}
}
console.log('film-aggregate-bundle ok');
