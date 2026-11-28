// AIR-648: the shared Film resolver, aggregate and history run from the REAL Worker bundle (dist/server/index.js built by build.mjs), not only as ES modules.
// An ES-module test cannot see a name a scope fails to receive (it resolves the real import); the bundle can. The bundle is evaluated in a vm context with no Node
// globals beyond what a Worker has (no require, no process, no Buffer), so a hidden Node-only dependency is a ReferenceError here. Synthetic only; nothing is routed or served.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import {spawnSync} from 'node:child_process';
import {identityDigest as offlineIdentityDigest,FILM_AGGREGATE_CONTRACT as OFFLINE_CONTRACT} from '../src/film-aggregate-resolver.js';
import * as offlineAggregate from '../src/film-aggregate.js';
import * as offlineHistory from '../src/film-history-aggregate.js';

const built=spawnSync(process.execPath,['build.mjs'],{encoding:'utf8'});
assert.equal(built.status,0,built.stderr);
const text=fs.readFileSync('dist/server/index.js','utf8');
assert.ok(!/from 'node:|require\(|createHash\(/.test(text),'the bundle names no Node-only module or hash API');

// Worker-like world: standard globals only. The module's default export is captured, everything else runs as a script.
const world=vm.createContext({console,TextEncoder,TextDecoder,URL,URLSearchParams,crypto:crypto.webcrypto,structuredClone,Response,Request,Headers,AbortController,setTimeout,clearTimeout});
const script=text.replace(/^export default /m,'globalThis.__worker=').replace(/^export\s+/gm,'');
vm.runInContext(script+'\n;globalThis.__scopes={Sha256Sync,FilmAggregateResolver,FilmAggregate,FilmHistoryAggregate};',world,{filename:'dist/server/index.js'});
const {Sha256Sync,FilmAggregateResolver,FilmAggregate,FilmHistoryAggregate}=world.__scopes;

// Every export of the offline modules is handed over by its scope, same names.
for(const [scope,offline,label] of [[FilmAggregateResolver,{},'resolver'],[FilmAggregate,offlineAggregate,'aggregate'],[FilmHistoryAggregate,offlineHistory,'history']]){
 for(const name of Object.keys(offline))assert.ok(name in scope,label+' scope lacks '+name);
}
assert.equal(FilmAggregateResolver.FILM_AGGREGATE_CONTRACT,OFFLINE_CONTRACT);
assert.equal(FilmAggregate.FILM_AGGREGATE_ROUTE,offlineAggregate.FILM_AGGREGATE_ROUTE);
assert.equal(typeof FilmHistoryAggregate.readFilmHistory,'function');
assert.equal(FilmHistoryAggregate.historyEventId('s','e'),offlineHistory.historyEventId('s','e'));

// Digest parity through the bundle: raw text (UTF-8), the identity digest of a real-shaped snapshot, against node createHash and the offline module.
for(const sample of ['','ratings etag Ёлки 🎬','{"a":[1,2,3]}'])assert.equal(Sha256Sync.sha256Hex(sample),crypto.createHash('sha256').update(sample).digest('hex'));
const keys={films:['film_b','film_a'],pairs:[],movies:['m1']};
const snapshot={marker:{generation:2,state:'open'},films:['film_a','film_b'],redirects:[],revisions:[],owned:[],claimed:[],decisions:[]};
const viaBundle=FilmAggregateResolver.identityDigest(JSON.parse(JSON.stringify(keys)),JSON.parse(JSON.stringify(snapshot)));
assert.equal(viaBundle,offlineIdentityDigest(keys,snapshot));
assert.match(viaBundle,/^sha256:[0-9a-f]{64}$/);

// The history cursor and token helpers (which use the replaced domain-script globals) behave the same in the bundle.
const tokens=Object.fromEntries(['survivor','aliases','identity','coverage','sources'].map((name,i)=>[name,'sha256:'+String(i).repeat(64)]));
assert.equal(FilmHistoryAggregate.encodeHistoryCursor(10,tokens),offlineHistory.encodeHistoryCursor(10,tokens));
console.log('film-aggregate-bundle ok');
