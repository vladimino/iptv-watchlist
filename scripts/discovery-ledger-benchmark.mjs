// AIR-220 / ADR 0034: offline memory benchmark of the discovery ledger in `full` and `bounded` mode. Synthetic objects only:
// no network, no R2, no production data. For each ledger size it builds a full-mode store (one growing ledger) and the
// bounded store a bounded commit makes from it, then finds the smallest V8 old space (`--max-old-space-size`, MB) at which
// the commit and a discovery chunk complete. Object bodies live on disk, so the measured heap holds only what the Worker code
// itself materializes. The numbers are relative: Node's old-space limit approximates, but is not, the Workers isolate limit.
//
// Usage: node scripts/discovery-ledger-benchmark.mjs --output /absolute/dir/outside/repo [--sizes 20,40,63,90]
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {spawnSync} from 'node:child_process';
import {webcrypto} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const REPO=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const SEEN=22000,BASE=Date.UTC(2026,9,27,12);
const P_RUN='00000000-0000-4000-8000-000000000001',R_RUN='00000000-0000-4000-8000-000000000002';

// Disk-backed store with a copy-on-write overlay: reads fall back to the base directory, writes go to the overlay.
function diskStore(baseDir,overlayDir){
 const file=(dir,key)=>path.join(dir,encodeURIComponent(key));
 fs.mkdirSync(overlayDir,{recursive:true});
 const meta=new Map();let revision=0;
 const locate=key=>fs.existsSync(file(overlayDir,key))?file(overlayDir,key):baseDir&&fs.existsSync(file(baseDir,key))?file(baseDir,key):null;
 const etagOf=key=>{if(!meta.has(key)){const where=locate(key);if(!where)return null;meta.set(key,'b'+fs.statSync(where).size+'-'+(++revision));}return meta.get(key);};
 return {
  async get(key){const where=locate(key);if(!where)return null;const etag=etagOf(key);return {etag,size:fs.statSync(where).size,json:async()=>JSON.parse(new TextDecoder().decode(fs.readFileSync(where))),text:async()=>new TextDecoder().decode(fs.readFileSync(where))};},
  async put(key,value,options={}){const c=options.onlyIf,exists=!!locate(key);if(c?.etagDoesNotMatch==='*'&&exists||c?.etagMatches&&c.etagMatches!==etagOf(key))return null;fs.writeFileSync(file(overlayDir,key),typeof value==='string'?value:String(value));meta.set(key,'o'+(++revision));return {etag:meta.get(key)};},
  async list({prefix=''}={}){const keys=new Set();for(const dir of [baseDir,overlayDir].filter(Boolean))for(const name of fs.readdirSync(dir)){const key=decodeURIComponent(name);if(key.startsWith(prefix))keys.add(key);}return {objects:[...keys].sort().map(key=>({key})),truncated:false};},
  async delete(key){fs.rmSync(file(overlayDir,key),{force:true});meta.delete(key);}
 };
}
function loadWorker(){
 const context=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,TextDecoder,Uint8Array,crypto:webcrypto,setTimeout,ASSETS:{},console:{...console,log:()=>{}},fetch:async()=>new Response('unavailable',{status:599})});
 vm.runInContext(fs.readFileSync(path.join(REPO,'src/domain/film-person.js'),'utf8'),context);
 for(const file of ['src/domain/scored-resolution.js','src/domain/resolution-acceptance.js','src/sources.js','src/discovery.js','src/enrichment.js','src/continuation.js','src/worker.js'])vm.runInContext(fs.readFileSync(path.join(REPO,file),'utf8').replace('export default','globalThis.worker=').replace('export const DiscoveryContinuation','const DiscoveryContinuation'),context);
 return context;
}

// Synthetic shapes. Ledger items: ~1 KB with Cyrillic titles and descriptions; the first SEEN are in the latest scan.
const RU=['Брат','Сибирский цирюльник','Москва слезам не верит','Ирония судьбы','Кин-дза-дза','Сталкер','Зеркало','Солярис'];
const title=i=>RU[i%8]+' '+i+' ('+(1960+i%60)+')';
function raw(i,day){const start=BASE+day*86400000+(i%20)*3600000,t=title(i);return {key:null,confirmedTmdbId:null,title:t,rawTitles:[t],normalizedTitle:null,year:1960+i%60,duration:95,description:'Описание фильма '.repeat(14).slice(0,180),firstAiring:start,lastAiring:start,airings:1,shows:[{channelId:'ch'+(i%300),channel:'Канал '+(i%300),start,end:start+5400000,epgTitle:t},{channelId:'ch'+((i+1)%300),channel:'Канал '+((i+1)%300),start:start+86400000,end:start+91800000,epgTitle:t}]};}
const film=(i,catalog)=>({id:(catalog?'c':'w')+i,tmdbId:String(100000+i+(catalog?50000:0)),title:RU[i%8]+' '+i,original:'Original '+i,year:1960+i%60,runtime:95,synopsis:'Синопсис '.repeat(30),directors:[{id:'p'+i,name:'Режиссёр '+i}],cast:Array.from({length:6},(_,k)=>({id:'a'+i+'-'+k,name:'Актёр '+k})),shows:[],aliases:['alias '+i]});
const sized=(make,bytes)=>Math.max(1,Math.round(bytes/Buffer.byteLength(JSON.stringify(make(1)))));
const scanOf=(total,day)=>{const out=[];for(let i=0;i<SEEN;i++){if(day&&i%20===0)continue;out.push(raw(i,day));}if(day)for(let i=SEEN;i<Math.min(total,SEEN+SEEN/20);i++)out.push(raw(i,day));return out;};

async function buildFixtures(dir,ledgerBytes){
 const context=loadWorker(),merge=vm.runInContext('mergeDiscoveryCandidates',context);
 const perItem=Buffer.byteLength(JSON.stringify(merge([],[raw(1,0)],{replaceShows:true,programmeRunId:P_RUN})[0]));
 const total=Math.max(SEEN+1000,Math.round(ledgerBytes/perItem));
 // The full ledger: every candidate ever seen; the first SEEN are in P's scan.
 const history=[];for(let i=0;i<total;i++)history.push(raw(i,-10-(i%7)));
 const ledger=merge(merge([],history,{replaceShows:true,programmeRunId:'00000000-0000-4000-8000-000000000000'}),scanOf(total,0),{replaceShows:true,programmeRunId:P_RUN});
 const fullDir=path.join(dir,'full');fs.mkdirSync(fullDir,{recursive:true});
 const write=(d,key,value)=>fs.writeFileSync(path.join(d,encodeURIComponent(key)),typeof value==='string'?value:JSON.stringify(value));
 const nWatch=sized(i=>film(i,false),2236877),nCat=sized(i=>film(i,true),5955495);
 const programme={runId:P_RUN,updatedAt:new Date(BASE).toISOString(),watchlistCount:nWatch,films:Array.from({length:nWatch},(_,i)=>film(i,false)),people:{},stats:{}};
 const catalog=Object.fromEntries(Array.from({length:nCat},(_,i)=>{const f=film(i,true);return [f.id,f];}));
 const pred=i=>({prediction:{profileVersion:1,profileHash:'p',summary:'Прогноз '.repeat(40)},fingerprint:{text:'Отпечаток '.repeat(30)}});
 const viewIndex=Object.fromEntries(Array.from({length:sized(pred,4553890)},(_,i)=>['c'+i,pred(i)]));
 const ledgerObject={programmeRunId:P_RUN,updatedAt:new Date(BASE).toISOString(),items:ledger};
 for(const key of ['epg/discovery-latest.json','epg/generations/'+P_RUN+'/discovery-latest.json'])write(fullDir,key,ledgerObject);
 for(const key of ['programme.json','epg/generations/'+P_RUN+'/programme.json'])write(fullDir,key,programme);
 for(const key of ['epg/discovered-films.json','epg/generations/'+P_RUN+'/discovered-films.json'])write(fullDir,key,catalog);
 write(fullDir,'epg/published-generation.json',{programmeRunId:P_RUN,phase:'published'});
 write(fullDir,'epg/discovery-resolution.json',Object.fromEntries(Array.from({length:8800},(_,i)=>['k'+i,{status:'verified',tmdbId:String(i)}])));
 write(fullDir,'enrichment/view-index.json',viewIndex);write(fullDir,'enrichment/profile/current.json',{version:1,profileHash:'p'});
 const fullBytes=fs.statSync(path.join(fullDir,encodeURIComponent('epg/discovery-latest.json'))).size;
 // The bounded store: what one bounded commit of P's own scan makes from the full store (the AIR-222 split, offline).
 const boundedDir=path.join(dir,'bounded');fs.cpSync(fullDir,boundedDir,{recursive:true});
 const store=diskStore(null,boundedDir),env={BUCKET:store,DISCOVERY_LEDGER_MODE:'bounded'};
 await store.put('sync.json',JSON.stringify({runId:P_RUN,stage:'epg'}));
 await store.put('epg/published-generation.json',JSON.stringify({programmeRunId:'00000000-0000-4000-8000-000000000000',phase:'published'}));
 await vm.runInContext('publishGenerationWithLedger',context)(env,P_RUN,scanOf(total,0),{programmeRunId:P_RUN},{'discovered-films.json':catalog,'programme.json':programme});
 const active=JSON.parse(fs.readFileSync(path.join(boundedDir,encodeURIComponent('epg/discovery-latest.json')),'utf8'));
 return {total,fullLedgerBytes:fullBytes,activeBytes:fs.statSync(path.join(boundedDir,encodeURIComponent('epg/discovery-latest.json'))).size,activeItems:active.items.length,archive:{items:active.archive?.items??0,bytes:active.archive?.bytes??0,segments:active.archive?.segments??0}};
}

async function child(scenario,dir){
 const [mode,step]=scenario.split('-'),overlay=fs.mkdtempSync(path.join(dir,'run-'));
 try{
  const context=loadWorker(),store=diskStore(path.join(dir,mode),overlay),env={BUCKET:store,DISCOVERY_LEDGER_MODE:mode,TMDB_API_READ_ACCESS_TOKEN:'t',TMDB_REQUEST_INTERVAL_MS:0};
  const total=JSON.parse(fs.readFileSync(path.join(dir,'shape.json'),'utf8')).total;
  if(step==='commit'){
   await store.put('sync.json',JSON.stringify({runId:R_RUN,stage:'epg'}));
   await vm.runInContext('publishGenerationWithLedger',context)(env,R_RUN,scanOf(total,1),{programmeRunId:R_RUN},{'programme.json':{runId:R_RUN,films:[]}});
  }else{
   await store.put('epg/resolver-continuation.json',JSON.stringify({stage:'paused',reason:'epg_committed',at:new Date().toISOString(),hopId:null,remainingChunks:12,nextCatchUpAt:null,retryAt:null,programmeRunId:P_RUN}));
   const response=await context.worker.fetch(new Request('https://iptv.invalid/api/enrichment/discovery/resolve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({limit:24})}),env,{waitUntil(){}});
   if(response.status!==200)throw new Error('chunk HTTP '+response.status);
  }
 }finally{fs.rmSync(overlay,{recursive:true,force:true});}
}
function minHeap(scenario,dir){
 const run=mb=>spawnSync(process.execPath,[...(mb?['--max-old-space-size='+mb,'--max-semi-space-size=1']:[]),fileURLToPath(import.meta.url),'--child',scenario,dir],{stdio:'ignore'}).status===0;
 if(!run(null))return {scenario,error:'fails without a limit'};
 let lo=16,hi=1024;while(hi-lo>4){const mid=(lo+hi)>>1;if(run(mid))hi=mid;else lo=mid;}
 return {scenario,minOldSpaceMB:hi};
}

const args=process.argv.slice(2),value=flag=>{const i=args.indexOf(flag);return i<0?null:args[i+1];};
if(args[0]==='--child'){await child(args[1],args[2]);process.exit(0);}
const output=value('--output');
if(!output||!path.isAbsolute(output)||path.resolve(output).startsWith(REPO+path.sep)){console.error('Usage: node scripts/discovery-ledger-benchmark.mjs --output /absolute/dir/outside/repo [--sizes 20,40,63,90]');process.exit(2);}
const report=[];
for(const mb of (value('--sizes')||'20,40,63,90').split(',').map(Number)){
 const dir=path.join(output,'ledger-'+mb+'mb');fs.rmSync(dir,{recursive:true,force:true});fs.mkdirSync(dir,{recursive:true});
 const shape=await buildFixtures(dir,mb*1048576);fs.writeFileSync(path.join(dir,'shape.json'),JSON.stringify(shape));
 const row={targetMB:mb,...shape,heap:{}};
 for(const scenario of ['full-commit','bounded-commit','full-chunk','bounded-chunk'])row.heap[scenario]=minHeap(scenario,dir).minOldSpaceMB??'error';
 report.push(row);console.log(JSON.stringify(row));
}
fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,1));
