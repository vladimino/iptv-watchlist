// A prediction run on the real Worker code with the prediction domain in D1 mode (as production runs it) over a sqlite D1 stand-in and an in-memory R2.
// Shared by the AIR-441 tests. Local stand-ins only; nothing here calls Cloudflare, TMDB or production.
import fs from 'node:fs';import vm from 'node:vm';import os from 'node:os';import path from 'node:path';import {installViewIndexFixture} from './view-index-fixture.mjs';
import {webcrypto} from 'node:crypto';
import * as Authority from '../src/discovery-authority.js';
import * as PredictionD1 from '../src/prediction-d1.js';
import * as PredictionAux from '../src/prediction-aux-d1.js';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-prediction-flow-'));
let databases=0;
let LABEL_STARTS=false;
export const labelStarts=(on=true)=>{LABEL_STARTS=on;};
export const sql=(file,text)=>{const result=sqliteSync(['-json','-bail',file],{input:text+';',encoding:'utf8',maxBuffer:1<<28});if(result.status!==0)throw new Error(result.stderr);const out=(result.stdout||'').trim();return out?JSON.parse(out):[];};
export function migrated(upTo=Infinity){
 const file=path.join(root,'flow-'+(databases++)+'.sqlite');
 const names=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)&&Number(name.slice(0,4))<=upTo).sort();
 const result=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+names.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'),encoding:'utf8'});
 if(result.status!==0)throw new Error(result.stderr||'migration failed');
 return file;
}
// `extra(n)` adds fields to film n (for example genres or a synopsis that fingerprint evidence cites).
// AIR-553: `aux:'closed'` sets the marker to closed (ADR 0196); `aux:'d1'` goes r2 -> closed -> d1 (the only chain the schema allows) and flips the auxiliary-state marker (stage, sources, manifest, outbox in D1) and gives the Worker scope the PredictionAux module; `aux:'r2'` gives the module with the marker at r2
// (the production default before the activation); without the option the module is absent, as in every older test.
export async function flowWorld({scope=true,films=40,extra=null,aux=null,schema=Infinity,rowStats=null}={}){
 const hooks={write:null,query:null};
 const records=new Map(),etags=new Map();let revision=0;
 const bucket={
  async get(key){return records.has(key)?{etag:etags.get(key),size:JSON.stringify(records.get(key)).length,json:async()=>structuredClone(records.get(key)),text:async()=>JSON.stringify(records.get(key))}:null;},
  async put(key,value,options={}){const c=options.onlyIf;if(c?.etagDoesNotMatch==='*'&&records.has(key)||c?.etagMatches&&c.etagMatches!==etags.get(key))return null;records.set(key,JSON.parse(value));etags.set(key,String(++revision));return {etag:etags.get(key)};},
  async head(key){return records.has(key)?{etag:etags.get(key)}:null;},list:async()=>({objects:[],truncated:false}),delete:async()=>{}
 };
 const logs=[],capture={log:(...a)=>logs.push(a.join(' ')),info:()=>{},error:()=>{},warn:()=>{}};
 const file=migrated(schema);
 sql(file,"UPDATE discovery_authority SET mode='d1', cutover='open' WHERE id=1");
 sql(file,"UPDATE prediction_domain_authority SET mode='d1' WHERE id=1");
 if(aux==='closed'||aux==='d1')sql(file,"UPDATE prediction_aux_authority SET mode='closed', generation=1 WHERE id=1");
 if(aux==='d1')sql(file,"UPDATE prediction_aux_authority SET mode='d1', generation=2, activated_at='2026-11-22T10:00:00.000Z' WHERE id=1");
 // A D1 round trip is a statement run on its own (`queries`) or a batch (`batches`); a batch of reads is not seen by `onQuery`.
 const stats={queries:0,batches:0,writeBatches:0};
 // hooks.query(text) sees every statement, run on its own or inside a batch (a test can count or react to the statements it cares about).
 const db=d1Standin(file,{rowStats,onQuery:text=>{stats.queries++;if(hooks.query)hooks.query(text);},onBatch:statements=>{stats.batches++;if(hooks.query)for(const item of statements)hooks.query(item.text);if(!statements.every(item=>/^\s*SELECT/i.test(item.text))){stats.writeBatches++;if(hooks.write)hooks.write(statements,stats.writeBatches);}}});
 const env={BUCKET:bucket,DB:db,PREDICTION_DB_REQUIRED:'on'};
 const module=scope?PredictionD1:{...PredictionD1,scopeRequest:undefined};
 const ctx=vm.createContext({Response,Request,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,Uint8Array,crypto:webcrypto,console:capture,setTimeout,DiscoveryAuthority:Authority,PredictionD1:module,...(aux?{PredictionAux}:{}),encodeURIComponent,decodeURIComponent});
 vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),ctx);
 for(const f of ['src/sources.js','src/discovery.js','src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/domain/prediction-versions.js','src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/worker.js'])vm.runInContext(fs.readFileSync(f,'utf8').replace('export default','globalThis.worker='),ctx);
 installViewIndexFixture(ctx);vm.runInContext('derivedViewIndex=async function(env,options){return PredictionD1.derivedIndex(env,options?.moodFacet===undefined?canonicalMoodFacet:options.moodFacet);}',ctx);// AIR-558: the prediction domain is real D1 here, so the derived index is its own rows (no ratings overlay in this world)
 // ADR 0195: the plain call, exactly as sent (the ownership tests use it for calls without a label).
 const rawApi=async(route,body)=>{const r=await ctx.worker.fetch(new Request('https://site.example/api/enrichment/'+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),env);return {status:r.status,data:await r.json()};};
 // A call of a run that carries a Task label sends that label, as the standing Task does; a run without one is called without. A test may opt in (`labelStarts()`) to label its real scheduled starts.
 const api=async(route,body)=>{
  if(LABEL_STARTS&&route==='batch/start'&&body&&body.trigger==='scheduled'&&body.dryRun!==true&&body.taskId===undefined)body={...body,taskId:'task00'};
  if(['heartbeat','complete','batch/hold','batch/submit'].includes(route)&&body&&typeof body.runId==='string'&&body.taskId===undefined&&body.dryRun!==true&&/^[A-Za-z0-9_-]{1,100}$/.test(body.runId)){
   const rows=sql(file,"SELECT document_json AS d FROM prediction_run WHERE run_id='"+body.runId+"'");const label=rows[0]?JSON.parse(rows[0].d).taskId:undefined;if(label)body={...body,taskId:label};
  }
  return rawApi(route,body);
 };
 const now=Date.now(),film=n=>({id:'tmdb_'+n,title:'tmdb_'+n,original:'tmdb_'+n,year:2020,tmdbId:String(n),canonicalIdentity:'tmdb:'+n,genres:[],actors:[],directors:[],shows:[{start:now}],...(extra?extra(n):{})});
 const list=[];for(let n=1;n<=films;n++)list.push(film(n));
 sql(file,"INSERT INTO discovery_admission (film_id, tmdb_id, media_kind, canonical_identity, observation_key, programme_run_id, generation, state, payload_json) VALUES "+list.map(f=>"('"+f.id+"','"+f.tmdbId+"','movie','"+f.canonicalIdentity+"','"+f.id+"','p1',1,'current','"+JSON.stringify(f).replace(/'/g,"''")+"')").join(','));
 records.set('programme.json',{runId:'p1',films:[]});records.set('sync.json',{runId:'p1',stage:'complete'});
 const profile={version:1,profileHash:'p',profile:{ratingScale:'Half stars'}};
 records.set('enrichment/profile/versions/1.json',profile);
 await PredictionD1.saveMutable(env,'enrichment/profile/current.json',profile);
 const EXECUTION=JSON.parse(JSON.stringify(vm.runInContext('EXECUTION',ctx)));
 const execution=Object.fromEntries(Object.entries(EXECUTION).map(([k,v])=>[k,v.includes('unknown')?'unknown':v[0]]));
 const fingerprint={fingerprintSchemaVersion:1,plotMechanics:['heist','investigation'],execution,moodLabels:['мрачный','напряжённый'],strengths:['A causal puzzle'],risks:['Mixed payoff'],confidence:'medium',sourceBasis:'model_knowledge',sourceRefs:['model_knowledge']};
 const prediction={predictedRating:3.5,probability4Plus:.45,confidence:'medium',matchSignals:['Investigation'],mainRisk:'Mixed payoff',moodLabels:['мрачный','напряжённый']};
 const manifests=new Map();
 return {records,file,env,db,stats,hooks,api,rawApi,logs,ctx,fingerprint,prediction,
  // Batch runner v2 (the only runner since ADR 0167): rebuild the queue, then one batch start whose answer is the manifest (runId, lease.epoch, films).
  async reconcileAndStart(body={}){const built=await api('queue/reconcile',{});const start=await api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:LABEL_STARTS?'scheduled':'manual',capacity:{remainingPercent:100},...body});if(start.status===200&&start.data.runId)manifests.set(start.data.runId,{manifest:start.data,sent:new Set()});return {built,start};},
  // One film per batch submit: the next manifest film of the run not yet sent. Returns the answer and the D1 round trips of the submit.
  async pair(runId,item={}){
   const held=manifests.get(runId);if(!held)throw new Error('pair: no manifest for run '+runId);
   const film=held.manifest.films.find(f=>!held.sent.has(f.filmId));if(!film)throw new Error('pair: manifest spent');held.sent.add(film.filmId);
   const trips=()=>stats.queries+stats.batches,q0=trips();
   const submit=await api('batch/submit',{runId,epoch:held.manifest.lease.epoch,items:[{filmId:film.filmId,...(film.plan==='prediction_only'?{}:{fingerprint}),prediction,...item}]});
   return {filmId:film.filmId,plan:film.plan,submit,submitQueries:trips()-q0};
  }};
}
