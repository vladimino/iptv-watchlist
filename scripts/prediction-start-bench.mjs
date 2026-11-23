// AIR-588: offline cost of one labelled Task `batch_start` on the BUILT Worker bundle (dist/server/index.js, every module the deployed Worker carries) over a sqlite D1
// stand-in migrated to the full chain and an in-memory R2, seeded by the local-dev fixture store (scripts/local-d1.mjs) widened to a synthetic catalog. It reads the
// Worker's own `prediction_step_timing` line (the same instrumentation production logs) and prints the D1 and R2 call counts per stage and per class, the answer bytes
// and the sizes of the stored manifest parts. No Cloudflare, model, TMDB or production call. Latency here is NOT production latency: `modelMs` multiplies the counts by
// the mean per-call times of one production start (23 Nov 2026 20:35 UTC: 126.7 s over 486 D1 calls, 38.4 s over 91 R2 calls) and is a model only.
// Usage: npm run build && node scripts/prediction-start-bench.mjs [--films 40] [--manifest 7] [--drift] [--compact] [--json]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {d1Standin} from '../tests/d1-standin.mjs';
import {MemoryBucket} from '../tests/memory-bucket.mjs';
import {installLocalD1} from './local-d1.mjs';
import {loadLocalCatalog,buildLocalFixtures} from './local-fixtures.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const arg=(name,fallback)=>{const at=process.argv.indexOf('--'+name);return at>0?process.argv[at+1]:fallback;};
const flag=name=>process.argv.includes('--'+name);
const FILMS=Number(arg('films',40)),MANIFEST=Number(arg('manifest',7));
const D1_MS=126678/486,R2_MS=38363/91;

// A synthetic catalog from the three fixture films: unique ids and TMDB ids, no stored prediction or fingerprint (every film needs work), half of them airing in the hot window.
async function catalogOf(n){
 const base=await loadLocalCatalog();
 const films=[];
 for(let i=0;i<n;i++){
  const t=base.films[i%base.films.length];
  const {prediction,mechanics,moods,execution,actualRating,started,...rest}=t;void prediction;void mechanics;void moods;void execution;void actualRating;void started;
  films.push({...rest,id:'bench-'+i,tmdbId:String(800000+i),title:'Bench '+i,original:'Bench '+i,shows:i%2===0?[{offsetHours:2+(i%10),durationHours:2,channel:'Channel1',channelId:'channel-1'}]:[]});
 }
 return {films};
}
async function world(){
 const file=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'iptv-start-bench-')),'d1.sqlite');
 const db=d1Standin(file),bucket=new MemoryBucket();
 const env={DB:db,BUCKET:bucket,PREDICTION_DB_REQUIRED:'on',RATINGS_DB_REQUIRED:'on'};
 const catalog=await catalogOf(FILMS);
 for(const item of buildLocalFixtures(catalog))await bucket.put(item.key,JSON.stringify(item.json));
 await installLocalD1(env,{catalog});
 return {env,file,db,bucket};
}
const logs=[];
const original=console.log;
console.log=(...a)=>{logs.push(a.join(' '));};
const {default:worker}=await import(pathToFileURL(path.join(root,'dist/server/index.js')).href+'?t='+Date.now());
const ctx={waitUntil(){},passThroughOnException(){}};
const call=async(env,route,body)=>{const r=await worker.fetch(new Request('https://iptv.example/api/enrichment/'+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),env,ctx);let data=null;try{data=await r.json();}catch{data=null;}return {status:r.status,data};};
const stepLine=step=>logs.map(l=>{try{return JSON.parse(l);}catch{return null;}}).filter(l=>l?.event==='prediction_step_timing'&&l.step===step).at(-1);

const w=await world();
const rec=await call(w.env,'queue/reconcile',{});
if(rec.status!==200){console.log=original;console.error('reconcile failed',rec.status,JSON.stringify(rec.data).slice(0,300));process.exit(1);}
if(flag('drift')){
 // An ordering-only drift of the same generation (AIR-529): Discovery assigns one more show to the published generation, so the live assigned-shows signature no longer
 // matches the one the stored queue was ranked on; nothing else moves.
 const at=Date.now()+3*3600000;
 w.db.sql("INSERT INTO published_epg_show (programme_run_id, film_id, channel_id, start_ms, end_ms, channel, epg_title, basis, match_reason) VALUES ('local-fixture','bench-1','channel-1',"+at+","+(at+7200000)+",'Channel1',NULL,'discovery','bench')");
}
logs.length=0;
const body={scope:'watchlist_all',mode:'queued',trigger:'scheduled',manifestSize:MANIFEST,taskId:'task00',...(flag('compact')?{answer:'envelope'}:{})};
const started=await call(w.env,'batch/start',body);
const line=stepLine('batch_start');
console.log=original;
const answerBytes=Buffer.byteLength(JSON.stringify(started.data));
const parts={};
if(started.data?.runId){
 const stored=JSON.parse((await w.bucket.objects.get('enrichment/batch-manifest/'+started.data.runId+'.json'))?.text||'null');
 if(stored){
  parts.full=Buffer.byteLength(JSON.stringify(stored));
  parts.profile=Buffer.byteLength(JSON.stringify(stored.profile));parts.contract=Buffer.byteLength(JSON.stringify(stored.contract));
  const films=(stored.films||[]).map(f=>Buffer.byteLength(JSON.stringify(f)));parts.filmMax=Math.max(...films);parts.filmSum=films.reduce((a,b)=>a+b,0);
 }
}
const leaseMirrorPuts=line?.classes?.['r2:lease']?.ops?.put||0;
const out={scenario:{films:FILMS,manifest:MANIFEST,drift:flag('drift'),compact:flag('compact')},status:started.status,answerStatus:started.data?.status,filmsSelected:started.data?.filmsSelected??started.data?.films?.length??null,
 d1:line?.d1?.n,r2:line?.r2?.n,leaseMirrorPuts,refreshRounds:line?.notes?.refreshRounds,preflights:line?.notes?.preflights,
 stages:Object.fromEntries((line?.stages||[]).map(s=>[s.stage,{d1:s.d1,r2:s.r2}])),
 schemaProbes:{sqlite_master:line?.classes?.['d1:sqlite_master']?.n||0,schema_contract:line?.classes?.['d1:schema_contract']?.n||0},
 answerBytes,manifestBytes:line?.notes?.manifestBytes,parts,...(flag('classes')?{classes:Object.fromEntries(Object.entries(line?.classes||{}).map(([k,v])=>[k,v.n]))}:{}),modelMs:Math.round((line?.d1?.n||0)*D1_MS+(line?.r2?.n||0)*R2_MS)};
if(flag('json'))process.stdout.write(JSON.stringify(out)+'\n');
else console.log(JSON.stringify(out,null,1));
