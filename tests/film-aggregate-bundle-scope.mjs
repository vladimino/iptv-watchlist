// AIR-648: loads the shared Film resolver / aggregate / history scopes from the REAL Worker bundle (dist/server/index.js, built by build.mjs) into a Worker-like vm
// context: standard globals only, no require, process or Buffer, so a hidden Node-only dependency is a ReferenceError. The Request, Response and URL constructors are the
// ones a Worker has; the D1 stand-in and its calls stay in the test's realm.
// A value built inside the context has the context's Object.prototype, which strict deepEqual rejects against a value of the test's realm. `plain` therefore returns the JSON
// form of a result (the same form a route serves), so a bundled read and an offline read are compared as JSON, never as shared object identities.
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import {spawnSync} from 'node:child_process';

export const plain=value=>value===undefined?undefined:JSON.parse(JSON.stringify(value));

export function loadBundledFilmScopes({build=true}={}){
 if(build){const built=spawnSync(process.execPath,['build.mjs'],{encoding:'utf8'});if(built.status!==0)throw new Error(built.stderr);}
 const text=fs.readFileSync('dist/server/index.js','utf8');
 const world=vm.createContext({console,TextEncoder,TextDecoder,URL,URLSearchParams,crypto:crypto.webcrypto,structuredClone,Response,Request,Headers,AbortController,setTimeout,clearTimeout});
 const script=text.replace(/^export default /m,'globalThis.__worker=').replace(/^export\s+/gm,'');
 vm.runInContext(script+'\n;globalThis.__scopes={Sha256Sync,FilmAggregateResolver,FilmAggregate,FilmReadiness,FilmDimensionParity,FilmReadinessReader,FilmReadinessComposition,FilmHistoryAggregate};',world,{filename:'dist/server/index.js'});
 return {text,worker:world.__worker,...world.__scopes};
}
