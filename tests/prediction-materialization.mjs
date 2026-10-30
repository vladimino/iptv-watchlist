import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';

// The one-time historical prediction version materialization is retired (ADR 0050). Whatever the PREDICTION_MATERIALIZATION
// binding, method or body, the route answers 410 Gone before reading the body: no bucket read, list or write, no lease, no
// receipt and no outbound request. The submit still writes immutable versions; the offline plan rule stays.
const records=new Map(),operations=[],fetches=[];
const bucket={
 async get(key){operations.push(['get',key]);return records.has(key)?{etag:'e',text:async()=>records.get(key),json:async()=>JSON.parse(records.get(key))}:null;},
 async put(key,value){operations.push(['put',key]);records.set(key,String(value));return {etag:'e'};},
 async delete(key){operations.push(['delete',key]);records.delete(key);},
 async list(options){operations.push(['list',options?.prefix]);return {objects:[],truncated:false};}
};
const ctx=vm.createContext({Response,Request,URL,URLSearchParams,Date,Map,Set,JSON,TextEncoder,Uint8Array,AbortSignal,crypto:webcrypto,console,setTimeout,fetch:async url=>{fetches.push(String(url));throw new Error('no network in this test');}});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),ctx);
for(const file of ['src/domain/prediction-versions.js','src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/sources.js','src/discovery.js','src/enrichment.js','src/letterboxd-diary.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),ctx);
const env={BUCKET:bucket};

// A legacy bundle without pointers and a receipt of the completed run stay exactly as they are.
records.set('enrichment/films/tmdb_7/predictions.json',JSON.stringify({current:{filmId:'tmdb_7',predictedRating:4,generatedAt:'2026-10-26T09:00:00.000Z'},history:[]}));
records.set('enrichment/predictions-materialization/'+'a'.repeat(64)+'/0.json',JSON.stringify({schemaVersion:2,complete:true}));
const stored=()=>JSON.stringify([...records.entries()].sort());
const before=stored();
const valid=JSON.stringify({planId:'a'.repeat(64),batch:0,items:[{filmId:'tmdb_7',expectedEtag:'e',expectedSha256:'b'.repeat(64)}],dryRun:false});
const bodies=[valid,JSON.stringify({planId:'a'.repeat(64),batch:0,items:[],dryRun:true}),JSON.stringify({}),'not json',null];
for(const flag of [undefined,'on','off','On',' on',true])for(const method of ['POST','GET','PUT'])for(const body of bodies){
 if(method==='GET'&&body!==null)continue;
 operations.length=0;fetches.length=0;
 const init={method,headers:{'Content-Type':'application/json',Origin:'https://site.example'}};if(body!==null)init.body=body;
 const response=await ctx.worker.fetch(new Request('https://site.example/api/enrichment/predictions/materialize',init),flag===undefined?env:{...env,PREDICTION_MATERIALIZATION:flag});
 const data=await response.json();
 assert.equal(response.status,410,`${method} with PREDICTION_MATERIALIZATION=${flag} and body ${body} is gone`);
 assert.equal(data.error,'gone');
 assert.match(data.detail,/retired/);
 assert.deepEqual(operations,[],`${method} with PREDICTION_MATERIALIZATION=${flag} touches no stored object`);
 assert.deepEqual(fetches,[]);
}
assert.equal(stored(),before,'no bundle, version object, receipt or lease was written');

// No code path reads the retired switch or keeps the handler; the CLI that called the route is gone.
for(const file of ['src/enrichment.js','src/letterboxd-diary.js','src/worker.js','src/sources.js','src/discovery.js','src/feature-flags.js'])assert.doesNotMatch(fs.readFileSync(file,'utf8'),/env\??\.PREDICTION_MATERIALIZATION|predictionMaterializationEnabled|materializePredictionVersions|materializeFilm/,file);
assert.equal(fs.existsSync('scripts/prediction-versions-materialize.mjs'),false);
assert.doesNotMatch(fs.readFileSync('package.json','utf8'),/prediction-versions-materialize/);
// The shared plan rule stays for the offline tools.
assert.equal(typeof vm.runInContext('predictionMaterializationPlan',ctx),'function');
console.log('Prediction version materialization retired: 410 Gone for every binding, method and body with no read, write or request; no handler, switch reader or CLI left; the offline plan rule stays');
