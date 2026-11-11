// AIR-438: offline profile of what one prediction `next` and `submit` ask of storage, as a function of the three batch sizes the runner has:
//   selection batch S  films the run selects at `start`/`next` (start rejects more than MAX_PREDICTION_BATCH = 20)
//   next request r     items one `next` hands to the model (HTTP allows up to 20; the MCP tool always sends 1)
//   submit batch s     items one `submit` takes (HTTP allows up to 10; the MCP tool accepts exactly 1)
// It runs the real Worker code (the vm harness of the tests) on an in-memory R2 and counts, with the AIR-438 step timer, how many storage
// calls and bytes each step makes and in which class. Storage-call counts are exact and byte sizes repeat to within a few bytes (timestamp lengths); both are the output; the milliseconds of an
// in-memory run say nothing about Cloudflare and are not printed. Larger S than 20 cannot be executed (the API refuses it): the table
// extrapolates the measured linear part and says so. No network, no production data, no D1: the D1-routed reads of production (the published
// programme, the prediction-domain tables) are NOT in these counts and are what the production telemetry has to measure.
//
// Usage: node scripts/prediction-batch-profile.mjs [--json]
import fs from 'node:fs';import vm from 'node:vm';import {webcrypto} from 'node:crypto';

function world(){
 const records=new Map(),etags=new Map();let revision=0;const logs=[];
 const env={BUCKET:{
  async get(key){return records.has(key)?{etag:etags.get(key),size:JSON.stringify(records.get(key)).length,json:async()=>structuredClone(records.get(key))}:null;},
  async put(key,value,options={}){const condition=options.onlyIf;if(condition?.etagDoesNotMatch==='*'&&records.has(key)||condition?.etagMatches&&condition.etagMatches!==etags.get(key))return null;records.set(key,JSON.parse(value));etags.set(key,String(++revision));return {etag:etags.get(key)};},
  async head(key){return records.has(key)?{etag:etags.get(key)}:null;},
  list:async()=>({objects:[],truncated:false})
 }};
 const consoleStub={log:(...a)=>logs.push(a.join(' ')),info:()=>{},error:()=>{},warn:()=>{}};
 const ctx=vm.createContext({Response,Request,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,Uint8Array,crypto:webcrypto,console:consoleStub});
 vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),ctx);
 for(const file of ['src/sources.js','src/discovery.js','src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/domain/prediction-versions.js','src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),ctx);
 ctx.env=env;
 const api=async(route,body)=>{const r=await ctx.worker.fetch(new Request('https://site.example/api/enrichment/'+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),env);const text=await r.text();return {status:r.status,data:JSON.parse(text),bytes:text.length};};
 return {records,ctx,api,logs};
}
const now=Date.now(),film=id=>({id,title:id,original:id,year:2020,tmdbId:id.replace(/\D/g,'')||id,genres:['Drama'],actors:['A B','C D'],directors:['E F'],overview:'Описание фильма '.repeat(30),shows:[{start:now}]});
const lineOf=(w,step)=>{const found=w.logs.filter(l=>l.includes('"prediction_step_timing"')).map(l=>JSON.parse(l)).filter(l=>l.step===step);return found[found.length-1];};
const callsOf=line=>Object.values(line.classes).reduce((n,c)=>n+Object.entries(c.ops).filter(([op])=>op!=='body').reduce((m,[,k])=>m+k,0),0);
const byClass=line=>Object.fromEntries(Object.entries(line.classes).map(([label,c])=>[label,{calls:Object.entries(c.ops).filter(([op])=>op!=='body').reduce((m,[,k])=>m+k,0),bytes:c.bytes}]));

// One run: `start` selects S films; then `warm` steady-state next/submit pairs of one film, and one measured pair with request r and submit s.
export async function measure({S,r,s,catalogSize=130,profileChars=6000}){
 const w=world();
 const execution=Object.fromEntries(Object.entries(vm.runInContext('EXECUTION',w.ctx)).map(([key,values])=>[key,values.includes('unknown')?'unknown':values[0]]));
 const fingerprint={fingerprintSchemaVersion:1,plotMechanics:['investigation'],execution,moodLabels:['мрачный','напряжённый'],strengths:['A causal puzzle'],risks:['Mixed payoff'],confidence:'medium',sourceBasis:'model_knowledge',sourceRefs:['model_knowledge']};
 const prediction={predictedRating:3.5,probability4Plus:.45,confidence:'medium',matchSignals:['Investigation'],mainRisk:'Mixed payoff',moodLabels:['мрачный','напряжённый']};
 w.records.set('enrichment/profile/current.json',{version:1,profileHash:'p',profile:{ratingScale:'Half stars',notes:'x'.repeat(profileChars)}});w.records.set('sync.json',{runId:'test',stage:'complete'});
 const catalog={};for(let i=1;i<=catalogSize;i++)catalog['tmdb_'+(900+i)]=film('tmdb_'+(900+i));
 w.records.set('programme.json',{runId:'test',films:[]});w.records.set('epg/discovered-films.json',catalog);
 const start=await w.api('start',{scope:'watchlist_all',batchSize:S,capacity:{remainingPercent:100}});
 if(start.status!==200||start.data.batchSize!==S)throw new Error('start did not select '+S+': '+JSON.stringify(start.data).slice(0,200));
 const next=await w.api('next',{runId:start.data.runId,batchSize:r});
 const items=next.data.items.slice(0,s);
 const submit=await w.api('submit',{runId:start.data.runId,items:items.map(i=>({filmId:i.filmId,fingerprint,prediction}))});
 if(submit.status!==200)throw new Error('submit failed '+JSON.stringify(submit.data).slice(0,200));
 const nextLine=lineOf(w,'next'),submitLine=lineOf(w,'submit');
 return {S,r,s,items:next.data.items.length,
  next:{calls:callsOf(nextLine),r2Bytes:nextLine.r2.bytesIn+nextLine.r2.bytesOut,responseBytes:next.bytes,classes:byClass(nextLine)},
  submit:{calls:callsOf(submitLine),r2Bytes:submitLine.r2.bytesIn+submitLine.r2.bytesOut,requestBytes:JSON.stringify({runId:'x',items:items.map(i=>({filmId:i.filmId,fingerprint,prediction}))}).length,classes:byClass(submitLine)}};
}
// Least squares line through (x, y); the largest residual says how linear the measurement is.
function fit(points){
 const n=points.length,sx=points.reduce((a,[x])=>a+x,0),sy=points.reduce((a,[,y])=>a+y,0),sxx=points.reduce((a,[x])=>a+x*x,0),sxy=points.reduce((a,[x,y])=>a+x*y,0);
 const slope=(n*sxy-sx*sy)/(n*sxx-sx*sx||1),intercept=(sy-slope*sx)/n;
 return {intercept:Math.round(intercept*100)/100,slope:Math.round(slope*100)/100,maxResidual:Math.round(Math.max(...points.map(([x,y])=>Math.abs(y-(intercept+slope*x))))*100)/100};
}
export async function profile(){
 const out={selection:[],nextRequest:[],submitBatch:[]};
 for(const S of [1,5,10,12,20])out.selection.push(await measure({S,r:1,s:1}));
 for(const r of [1,5,10,20])out.nextRequest.push(await measure({S:20,r,s:1}));
 for(const s of [1,2,5,10])out.submitBatch.push(await measure({S:20,r:10,s}));
 out.backlog=[];for(const catalogSize of [130,1000,3000,9257])out.backlog.push({films:catalogSize,...(await measure({S:12,r:1,s:1,catalogSize}))});
 out.batchAtBacklog=[];for(const sub of [1,5,10])out.batchAtBacklog.push({films:3000,...(await measure({S:12,r:10,s:sub,catalogSize:3000}))});
 const sel=out.selection;
 out.fit={
  nextCallsBySelection:fit(sel.map(m=>[m.S,m.next.calls])),submitCallsBySelection:fit(sel.map(m=>[m.S,m.submit.calls])),
  nextBytesBySelection:fit(sel.map(m=>[m.S,m.next.r2Bytes])),submitBytesBySelection:fit(sel.map(m=>[m.S,m.submit.r2Bytes])),
  nextCallsByRequest:fit(out.nextRequest.map(m=>[m.r,m.next.calls])),nextResponseBytesByRequest:fit(out.nextRequest.map(m=>[m.r,m.next.responseBytes])),
  submitCallsByBatch:fit(out.submitBatch.map(m=>[m.s,m.submit.calls])),submitBytesByBatch:fit(out.submitBatch.map(m=>[m.s,m.submit.r2Bytes]))
 };
 // Extrapolation beyond what the API accepts: the measured line, not an execution.
 out.extrapolated=Object.fromEntries([20,50,100,500].map(S=>[S,{executed:S<=20,nextCalls:Math.round(out.fit.nextCallsBySelection.intercept+out.fit.nextCallsBySelection.slope*S),submitCalls:Math.round(out.fit.submitCallsBySelection.intercept+out.fit.submitCallsBySelection.slope*S),nextR2Bytes:Math.round(out.fit.nextBytesBySelection.intercept+out.fit.nextBytesBySelection.slope*S),submitR2Bytes:Math.round(out.fit.submitBytesBySelection.intercept+out.fit.submitBytesBySelection.slope*S)}]));
 return out;
}
// The throughput model behind the report's matrix. Every input is either a production observation of 11 November 2026 (the AIR-437 run table and
// the step walls read from Workers Observability) or an assumption named in SCENARIOS; nothing here is measured at Cloudflare for a batch size
// the API does not accept today, and the quality of a batched model call is not modelled at all, only its time.
//   per film:  T = m*G + o*(1/g + 1 + 1/s) + Wn(S)/g + Ws(s)/s
//   G   model time per film (24 s: the 36 s the caller spends between a `next` answer and the next `next` request, less three tool-call overheads of 4 s)
//   m   multiplier of G for a batched call, o per tool-call overhead (the validate call is per film whatever the batch: the contract requires it)
//   Wn  wall of a `next`: Wn0 at S = 12 scaled by how the selection batch grows its storage calls (31 + 2S calls measured; 55 at S = 12), best = 1
//       if the per-film reads run fully in parallel, worst = proportional to the calls, likely = halfway
//   Ws  wall of a `submit` of s items: Ws0 * (f + (1 - f) * s), f the share of a one-item submit that does not grow with s (measured on the stored
//       queue: 49 % of the calls, 73 % of the bytes)
export const SCENARIOS={
 best:{Wn0:16,Ws0:19,f:.73,nScale:'parallel',m:.8,o:4},
 likely:{Wn0:45,Ws0:43,f:.6,nScale:'half',m:1,o:4},
 worst:{Wn0:45,Ws0:43,f:.49,nScale:'calls',m:1.1,o:6}
};
export function filmsPerActiveHour({S,g,s},scenario,G=24){
 const c=SCENARIOS[scenario],serial=(31+2*S)/55,scale=c.nScale==='parallel'?1:c.nScale==='calls'?serial:(1+serial)/2;
 const cycle=c.m*G+c.o*(1/g+1+1/s)+c.Wn0*scale/g+c.Ws0*(c.f+(1-c.f)*s)/s;
 return {secondsPerFilm:Math.round(cycle*10)/10,filmsPerHour:Math.round(3600/cycle*10)/10};
}
export const CONFIGS=[
 {name:'today: S=12, g=1, s=1',S:12,g:1,s:1},{name:'S=20, g=1, s=1',S:20,g:1,s:1},
 {name:'S=20, g=2, s=2',S:20,g:2,s:2},{name:'S=20, g=5, s=5',S:20,g:5,s:5},{name:'S=20, g=10, s=10',S:20,g:10,s:10},
 {name:'S=50, g=10, s=10 (S not accepted by start)',S:50,g:10,s:10},{name:'S=100, g=10, s=10 (not accepted)',S:100,g:10,s:10},{name:'S=500, g=10, s=10 (not accepted)',S:500,g:10,s:10}
];
if(import.meta.url===`file://${process.argv[1]}`){
 const result=await profile();
 if(process.argv.includes('--json'))console.log(JSON.stringify(result,null,1));
 else{
  console.log('selection batch S (r=1, s=1): storage calls and R2 bytes per step');
  for(const m of result.selection)console.log(`  S=${String(m.S).padStart(3)}  next ${String(m.next.calls).padStart(4)} calls ${String(m.next.r2Bytes).padStart(8)} B   submit ${String(m.submit.calls).padStart(4)} calls ${String(m.submit.r2Bytes).padStart(8)} B`);
  console.log('next request r (S=20):');for(const m of result.nextRequest)console.log(`  r=${String(m.r).padStart(3)}  items ${m.items}  next ${m.next.calls} calls  answer ${m.next.responseBytes} B`);
  console.log('submit batch s (S=20, r=10):');for(const m of result.submitBatch)console.log(`  s=${String(m.s).padStart(3)}  submit ${m.submit.calls} calls ${m.submit.r2Bytes} R2 B  request ${m.submit.requestBytes} B`);
  console.log('backlog size (S=12, r=1, s=1; the production queue holds 9257 films):');for(const m of result.backlog)console.log(`  films=${String(m.films).padStart(5)}  next ${m.next.calls} calls ${m.next.r2Bytes} B (queue ${m.next.classes['r2:queue']?.bytes} B)   submit ${m.submit.calls} calls ${m.submit.r2Bytes} B (queue ${m.submit.classes['r2:queue']?.bytes} B)`);
  console.log('submit batch at a 3000-film queue (S=12, r=10): per film');for(const m of result.batchAtBacklog)console.log(`  s=${String(m.s).padStart(2)}  next ${m.next.calls} calls ${m.next.r2Bytes} B  submit ${m.submit.calls} calls ${m.submit.r2Bytes} B   per film: ${Math.round((m.submit.calls+m.next.calls)/m.s)} calls, ${Math.round((m.submit.r2Bytes+m.next.r2Bytes)/m.s)} B`);
  console.log('throughput model (films per active hour; see the report for the assumptions)');for(const c of CONFIGS)console.log('  '+c.name.padEnd(48)+['best','likely','worst'].map(k=>k+' '+filmsPerActiveHour(c,k).filmsPerHour).join('   '));
  console.log('linear fits');console.log(JSON.stringify(result.fit));console.log('extrapolated by selection batch S');console.log(JSON.stringify(result.extrapolated));
 }
}
