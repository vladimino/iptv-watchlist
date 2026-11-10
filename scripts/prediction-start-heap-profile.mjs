// Offline heap profile of one prediction start at production-like sizes. Synthetic data only. Node heap is not workerd's 128 MiB limit; it ranks versions.
import fs from 'node:fs';import vm from 'node:vm';import {webcrypto} from 'node:crypto';
// Usage: node --expose-gc scripts/prediction-start-heap-profile.mjs [path to an enrichment.js to profile, default src/enrichment.js]
const enrichmentFile=process.argv[2]||"src/enrichment.js";
const store=new Map(),etags=new Map();let rev=0,peak=0,peakAt='';const counts={};
const MB=b=>Math.round(b/1048576*10)/10;
const mark=label=>{globalThis.gc();const used=process.memoryUsage().heapUsed;if(used>peak){peak=used;peakAt=label;}};
const env={BUCKET:{async get(key){counts[key]=(counts[key]||0)+1;if(!store.has(key))return null;const buf=store.get(key);mark('before get '+key);return {etag:etags.get(key),json:async()=>{const v=JSON.parse(buf.toString());mark('after get '+key);return v;},text:async()=>buf.toString()};},
 async put(key,value,options={}){const c=options.onlyIf;if(c?.etagDoesNotMatch==='*'&&store.has(key)||c?.etagMatches&&c.etagMatches!==etags.get(key))return null;mark('put '+key);store.set(key,Buffer.from(value));etags.set(key,String(++rev));return {etag:etags.get(key)};},list:async()=>({objects:[],truncated:false})}};
const quiet={log(){},info(){},warn(){},error(){}};
const ctx=vm.createContext({Response,Request,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,Uint8Array,crypto:webcrypto,console:quiet});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),ctx);
for(const file of ['src/sources.js','src/discovery.js','src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/domain/prediction-versions.js','src/domain/prediction-confidence.js',enrichmentFile,'src/letterboxd-diary.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),ctx);
const now=Date.now(),pad=n=>'x'.repeat(n);
const film=(i,hot)=>({id:'tmdb_'+(100000+i),title:'Film '+i,original:'Original '+i,year:1990+i%35,tmdbId:100000+i,genres:['Drama','Crime'],actors:Array.from({length:8},(_,k)=>'Actor '+i+'-'+k),directors:['Director '+i],synopsis:pad(1500),poster:pad(120),shows:hot?[{start:now-3600000*(i%40),channel:'ch'+i%90,title:pad(60)}]:[],discoveredAt:'2026-10-01T00:00:00.000Z',extra:pad(700)});
const catalog={};for(let i=0;i<8704;i++)catalog['tmdb_'+(100000+i)]=film(i,i<6400);
const programme={runId:'gen-new',films:Array.from({length:700},(_,i)=>film(20000+i,true))};
const index={};for(let i=0;i<8704;i++)index['tmdb_'+(100000+i)]=i<3255?{watched:false,fingerprintHash:'h'+i,fingerprint:{plotMechanics:['a','b'],moodLabels:['m','n'],execution:{pace:'fast'},fingerprintHash:'h'+i},impactFeatures:{fingerprintHash:'h'+i,fingerprintSchemaVersion:1,fingerprintPromptVersion:1,plotMechanics:['a','b'],execution:{pace:'fast'}},prediction:{predictedRating:3.5,generatedAt:'2026-11-01T00:00:00.000Z',tasteProfileVersion:1,tasteProfileHash:'p',fingerprintHash:'h'+i,fingerprintSchemaVersion:1,predictionPromptVersion:1,summary:pad(1800)},pad:pad(400)}:{watched:false,pad:pad(300)};
const set=(k,v)=>{store.set(k,Buffer.from(JSON.stringify(v)));etags.set(k,String(++rev));};
set('enrichment/profile/current.json',{version:1,profileHash:'p',profile:{ratingScale:'Half stars'}});set('sync.json',{runId:'gen-new',stage:'complete'});
set('programme.json',programme);set('epg/discovered-films.json',catalog);set('enrichment/view-index.json',index);
set('enrichment/prediction-queue.json',{schemaVersion:3,programmeRunId:'gen-old',pending:[],hotPending:[],coldPending:[],priority:{},retries:{},work:{}});
const sizes=Object.fromEntries(['programme.json','epg/discovered-films.json','enrichment/view-index.json'].map(k=>[k,MB(store.get(k).length)]));
globalThis.gc();const base=process.memoryUsage().heapUsed;const t0=performance.now();
const r=await ctx.worker.fetch(new Request('https://site.example/api/enrichment/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({scope:'watchlist_all',mode:'queued',trigger:'manual'})}),env);
const text=await r.text(),data=JSON.parse(text);
console.log(JSON.stringify({file:enrichmentFile,status:r.status,runStatus:data.status,answerChars:text.length,pending:JSON.parse(store.get('enrichment/prediction-queue.json').toString()).hotPending.length,sizesMB:sizes,baseMB:MB(base),peakLiveMB:MB(peak),peakAboveBaseMB:MB(peak-base),peakAt,ms:Math.round(performance.now()-t0),reads:{catalog:counts['epg/discovered-films.json'],index:counts['enrichment/view-index.json'],programme:counts['programme.json'],queue:counts['enrichment/prediction-queue.json']}}));
