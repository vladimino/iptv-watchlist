// A prediction run on the real Worker code with the prediction domain in D1 mode (as production runs it) over a sqlite D1 stand-in and an in-memory R2.
// Shared by the AIR-441 tests. Local stand-ins only; nothing here calls Cloudflare, TMDB or production.
import fs from 'node:fs';import vm from 'node:vm';import os from 'node:os';import path from 'node:path';import {webcrypto} from 'node:crypto';
import * as Authority from '../src/discovery-authority.js';
import * as PredictionD1 from '../src/prediction-d1.js';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-prediction-flow-'));
let databases=0;
export const sql=(file,text)=>{const result=sqliteSync(['-json','-bail',file],{input:text+';',encoding:'utf8',maxBuffer:1<<28});if(result.status!==0)throw new Error(result.stderr);const out=(result.stdout||'').trim();return out?JSON.parse(out):[];};
export function migrated(){
 const file=path.join(root,'flow-'+(databases++)+'.sqlite');
 const names=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
 const result=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+names.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'),encoding:'utf8'});
 if(result.status!==0)throw new Error(result.stderr||'migration failed');
 return file;
}
export async function flowWorld({scope=true,films=40}={}){
 const hooks={write:null};
 const records=new Map(),etags=new Map();let revision=0;
 const bucket={
  async get(key){return records.has(key)?{etag:etags.get(key),size:JSON.stringify(records.get(key)).length,json:async()=>structuredClone(records.get(key)),text:async()=>JSON.stringify(records.get(key))}:null;},
  async put(key,value,options={}){const c=options.onlyIf;if(c?.etagDoesNotMatch==='*'&&records.has(key)||c?.etagMatches&&c.etagMatches!==etags.get(key))return null;records.set(key,JSON.parse(value));etags.set(key,String(++revision));return {etag:etags.get(key)};},
  async head(key){return records.has(key)?{etag:etags.get(key)}:null;},list:async()=>({objects:[],truncated:false}),delete:async()=>{}
 };
 const logs=[],capture={log:(...a)=>logs.push(a.join(' ')),info:()=>{},error:()=>{},warn:()=>{}};
 const file=migrated();
 sql(file,"UPDATE discovery_authority SET mode='d1', cutover='open' WHERE id=1");
 sql(file,"UPDATE prediction_domain_authority SET mode='d1' WHERE id=1");
 // A D1 round trip is a statement run on its own (`queries`) or a batch (`batches`); a batch of reads is not seen by `onQuery`.
 const stats={queries:0,batches:0,writeBatches:0};
 const db=d1Standin(file,{onQuery:()=>{stats.queries++;},onBatch:statements=>{stats.batches++;if(!statements.every(item=>/^\s*SELECT/i.test(item.text))){stats.writeBatches++;if(hooks.write)hooks.write(statements,stats.writeBatches);}}});
 const env={BUCKET:bucket,DB:db,PREDICTION_DB_REQUIRED:'on'};
 const module=scope?PredictionD1:{...PredictionD1,scopeRequest:undefined};
 const ctx=vm.createContext({Response,Request,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,Uint8Array,crypto:webcrypto,console:capture,setTimeout,DiscoveryAuthority:Authority,PredictionD1:module,encodeURIComponent,decodeURIComponent});
 vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),ctx);
 for(const f of ['src/sources.js','src/discovery.js','src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/domain/prediction-versions.js','src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/worker.js'])vm.runInContext(fs.readFileSync(f,'utf8').replace('export default','globalThis.worker='),ctx);
 const api=async(route,body)=>{const r=await ctx.worker.fetch(new Request('https://site.example/api/enrichment/'+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),env);return {status:r.status,data:await r.json()};};
 const now=Date.now(),film=n=>({id:'tmdb_'+n,title:'tmdb_'+n,original:'tmdb_'+n,year:2020,tmdbId:String(n),canonicalIdentity:'tmdb:'+n,genres:[],actors:[],directors:[],shows:[{start:now}]});
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
 return {records,file,env,db,stats,hooks,api,logs,ctx,fingerprint,prediction,
  async reconcileAndStart(){const built=await api('queue/reconcile',{});const start=await api('start',{scope:'watchlist_all',capacity:{remainingPercent:100}});return {built,start};},
  // One film per step, as the MCP tools do. Returns the answers and the D1 round trips each step made.
  async pair(runId){
   const trips=()=>stats.queries+stats.batches,q0=trips(),next=await api('next',{runId,batchSize:1}),afterNext=trips();
   const submit=await api('submit',{runId,items:[{filmId:next.data.items[0].filmId,fingerprint,prediction}]});
   return {next,submit,nextQueries:afterNext-q0,submitQueries:trips()-afterNext};
  }};
}
