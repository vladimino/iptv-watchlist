// Offline heap profile of one EPG commit at the synthetic volumes of the live ledger.
// Node heap and RSS are not workerd's 128 MiB isolate limit. The script makes no network call and uses no production snapshot.
//
// Child: node --expose-gc scripts/epg-commit-memory-profile.mjs --child --mode stream|legacy [--gc-at-markers] [--out file]
// Optional volume flags: --ledger --latest --catalog --watch --archived --target-bytes
// Parent (default): runs the stream and legacy children and prints their summaries.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {once} from 'node:events';
import v8 from 'node:v8';
import {scoped} from './bundle-scope.mjs';
import {d1Standin} from '../tests/d1-standin.mjs';

const args=process.argv.slice(2);
const flag=name=>args.includes(name);
const value=(name,fallback)=>{const i=args.indexOf(name);return i>=0?args[i+1]:fallback;};
const MB=bytes=>Math.round(bytes/1048576*10)/10;

if(!flag('--child')){
 console.error('Usage: node --expose-gc scripts/epg-commit-memory-profile.mjs --child --mode stream|legacy [--gc-at-markers] [--gc-sample] [--out file]');
 console.error('Optional volumes: --ledger 34102 --latest 19868 --catalog 2631 --watch 395 --archived 23820 --target-bytes 43167390');
 process.exit(2);
}

const MODE=value('--mode','stream');
const GC=flag('--gc-at-markers');
const GC_SAMPLE=flag('--gc-sample');
const LEDGER=Number(value('--ledger','34102'));
const LATEST=Number(value('--latest','19868'));
const CATALOG=Number(value('--catalog','2631'));
const WATCH=Number(value('--watch','395'));
const ARCHIVED=Number(value('--archived','23820'));
const TARGET=Number(value('--target-bytes','43167390'));
const OUT=value('--out','');
const OLD='71820185-3cc1-4303-b674-14293dca938b';
const RUN='00ff34fa-e518-4ac7-ae63-b2e46f803503';
const REENTRY=LATEST-1;
const trace=[];
let retainedBytes=()=>0;
const note=row=>{trace.push(row);if(OUT)fs.appendFileSync(OUT,JSON.stringify(row)+'\n');};

const samples=new Map();
let phase='setup';
function snap(name,edge){
 if(GC&&global.gc)global.gc();
 const m=process.memoryUsage();
 const entry=samples.get(name)||{phase:name,peakHeapMB:0,peakRssMB:0,peakExternalMB:0,heapAtEnterMB:null,heapAtExitMB:null,externalAtEnterMB:null};
 if(edge==='enter'){entry.heapAtEnterMB=MB(m.heapUsed);entry.externalAtEnterMB=MB(m.external+m.arrayBuffers);}
 if(edge==='exit'||edge==='error')entry.heapAtExitMB=MB(m.heapUsed);
 entry.peakHeapMB=Math.max(entry.peakHeapMB,MB(m.heapUsed));
 entry.peakRssMB=Math.max(entry.peakRssMB,MB(m.rss));
 entry.peakExternalMB=Math.max(entry.peakExternalMB,MB(m.external+m.arrayBuffers));
 samples.set(name,entry);
 note({t:Date.now(),phase:name,edge,heapMB:MB(m.heapUsed),rssMB:MB(m.rss),externalMB:MB(m.external+m.arrayBuffers)});
}
 const sampler=setInterval(()=>{
 if(GC_SAMPLE&&global.gc)global.gc();
 const m=process.memoryUsage(),entry=samples.get(phase);
 if(!entry)return;
 const heap=MB(m.heapUsed),rss=MB(m.rss),external=MB(m.external+m.arrayBuffers);
 entry.peakHeapMB=Math.max(entry.peakHeapMB,heap);
 entry.peakRssMB=Math.max(entry.peakRssMB,rss);
 entry.peakExternalMB=Math.max(entry.peakExternalMB,external);
 note({t:Date.now(),phase,edge:'sample',heapMB:heap,rssMB:rss,externalMB:external,retainedMB:MB(retainedBytes())});
},50);

const context=vm.createContext({
 Response,Request,Headers,URL,URLSearchParams,Date,Map,Set,JSON,TextEncoder,TextDecoder,Uint8Array,ArrayBuffer,
 AbortSignal,AbortController,crypto:webcrypto,structuredClone,ReadableStream,setTimeout,clearTimeout,Promise,Intl,
 console:{log(line){try{const entry=JSON.parse(String(line));if(entry.event==='epg_phase'){phase=entry.phase;snap(entry.phase,entry.edge);}}catch{}}},
 fetch:async url=>{
  const href=String(url);
  if(href==='https://epg.invalid/guide.xml')return new Response(epgBody);
  if(href.startsWith('https://query.wikidata.org/'))return Response.json({results:{bindings:[]}});
  return new Response('',{status:404});
 }
});
let epgBody='';
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),context);
for(const file of ['src/domain/scored-resolution.js','src/domain/resolution-acceptance.js','src/sources.js','src/discovery.js','src/enrichment.js','src/continuation.js','src/worker.js']){
 vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker=').replace('export const DiscoveryContinuation','const DiscoveryContinuation'),context);
}
vm.runInContext(scoped('src/published-epg.js','PublishedEpg'),context);
const call=code=>vm.runInContext(code,context);
const keyOf=call('raw=>discoveryCandidateKey(raw)');
const segmentOf=call('key=>ledgerArchiveSegment(key,64)');

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-epg-commit-'));
const yearOf=i=>1990+(i%30);
function shown(kind,i){return kind+' '+i+' ('+yearOf(i)+')';}
function film(kind,i){
 const title=kind+' '+i,year=yearOf(i);
 return {id:kind.slice(0,1)+i,title,original:title,year,runtime:100,tmdbId:String(100000+i),aliases:[title],url:'https://letterboxd.com/film/'+kind.toLowerCase()+'-'+i+'/'};
}
const watch=Array.from({length:WATCH},(_,i)=>film('Список',i));
const reentryShown=shown('Кандидат',REENTRY);
const reentryKey=keyOf({title:reentryShown,year:yearOf(REENTRY)});
const reentrySegment=segmentOf(reentryKey);

function ledgerItem(i,pad){
 const title='Кандидат '+i,year=yearOf(i),raw=shown('Кандидат',i),key=keyOf({title:raw,year});
 const start=1_700_000_000_000+(i%5)*3_600_000;
 const shows=[0,1,2].map(j=>({channelId:'ch'+((i+j)%150),channel:'Канал '+((i+j)%150),start:start+j*60_000,end:start+j*60_000+6_000_000,epgTitle:raw}));
 return JSON.stringify({key,title,normalizedTitle:key.slice(0,key.lastIndexOf('|')),year,duration:100,description:'О'.repeat(pad),firstAiring:start,lastAiring:start+120_000,airings:3,shows,rawTitles:[raw]});
}
function ledgerHead(){
 const archive={version:'v1',manifestId:'manifest-frozen',segments:64,items:ARCHIVED,bytes:10,alsoArchived:[],uniqueArchivedItems:ARCHIVED};
 const meta={programmeRunId:OLD,updatedAt:'2026-11-02T16:13:02.965Z',rawCandidates:LEDGER,filteredNonMovies:0,ledgerMode:'frozen',archive};
 return JSON.stringify(meta).slice(0,-1)+',"items":[';
}
async function writeLedger(pad){
 const file=path.join(root,'ledger.json');
 const out=fs.createWriteStream(file);
 const write=async chunk=>{if(!out.write(chunk))await once(out,'drain');};
 await write(ledgerHead());
 let first=true,written=0;
 for(let i=0;written<LEDGER;i++){
  if(i===REENTRY)continue;
  await write((first?'':',')+ledgerItem(i,pad));
  first=false;written++;
 }
 await write(']}');
 await new Promise((resolve,reject)=>{out.end(resolve);out.on('error',reject);});
 return file;
}
let ledgerFile=await writeLedger(0);
let ledgerBytes=fs.statSync(ledgerFile).size;
if(TARGET>ledgerBytes&&LEDGER>0){
 const sample=Buffer.byteLength(ledgerItem(0,0));
 const padded=Buffer.byteLength(ledgerItem(0,100));
 const perChar=(padded-sample)/100;
 const gap=TARGET-ledgerBytes;
 const pad=Math.max(0,Math.floor(gap/(LEDGER*perChar)));
 if(pad>0){ledgerFile=await writeLedger(pad);ledgerBytes=fs.statSync(ledgerFile).size;}
}
const ledgerBuf=fs.readFileSync(ledgerFile);

function catalogItem(i,pad){
 const entry=film('Каталог',i);
 entry.id='tmdb_'+i;entry.catalog=true;entry.synopsis='С'.repeat(pad);
 return JSON.stringify(entry);
}
const catalogParts=['{'];
const catalogTarget=CATALOG>=2000?6_222_569:CATALOG*160;
const catalogPad=CATALOG>0?Math.max(0,Math.floor((catalogTarget-CATALOG*80)/Math.max(1,CATALOG))):0;
for(let i=0;i<CATALOG;i++)catalogParts.push((i?',':'')+JSON.stringify('tmdb_'+i)+':'+catalogItem(i,catalogPad));
catalogParts.push('}');
const catalogBuf=Buffer.from(catalogParts.join(''));
catalogParts.length=0;

const manifest={schemaVersion:1,manifestId:'manifest-frozen',parentManifestId:null,segmentCount:64,hash:'fnv1a32-utf8',segments:Array.from({length:64},(_,segment)=>({segment,object:segment===reentrySegment?'epg/discovery-archive/v1/segments/'+segment+'/write-1.json':null,sha256:null,items:segment===reentrySegment?1:0,bytes:0})),totals:{items:ARCHIVED,bytes:10},upsertedKeys:[reentryKey],writer:{runId:OLD,kind:'split'}};
const segmentBody={schemaVersion:1,segment:reentrySegment,writeId:'write-1',items:{[reentryKey]:{payload:{key:reentryKey,title:'Кандидат '+REENTRY,year:yearOf(REENTRY),description:'архив',firstAiring:1,lastAiring:1,airings:1,duration:100,shows:[],rawTitles:[reentryShown]},envelope:{archivedAt:'2026-10-28T00:00:00.000Z',archivedFromProgrammeRunId:OLD,archiveWriteId:'write-1'}}}};

function bucket(){
 const objects=new Map(),etags=new Map();let revision=0;
 const retained=()=>{let n=0;const seen=new Set();for(const buf of objects.values()){if(seen.has(buf))continue;seen.add(buf);n+=buf.length;}return n;};
 const streamOf=buf=>new ReadableStream({start(controller){const size=64*1024;for(let i=0;i<buf.length;i+=size)controller.enqueue(buf.subarray(i,Math.min(i+size,buf.length)));controller.close();}});
 const fresh=(key,buf)=>{
  const object={etag:null,size:buf.length,json:async()=>JSON.parse(buf.toString('utf8'))};
  const ledger=MODE==='stream'&&key.includes('discovery-latest.json');
  if(ledger)delete object.json;
  if(MODE==='stream')Object.defineProperty(object,'body',{get(){return streamOf(buf);}});
  return object;
 };
 retainedBytes=retained;
 return {
  async get(key){
   if(!objects.has(key))return null;
   const object=fresh(key,objects.get(key));object.etag=etags.get(key);return object;
  },
  async put(key,value,options={}){
   const only=options.onlyIf;
   if(only?.etagDoesNotMatch==='*'&&objects.has(key)||only?.etagMatches&&only.etagMatches!==etags.get(key))return null;
   let buf;
   if(typeof value==='string')buf=Buffer.from(value);
   else if(Buffer.isBuffer(value))buf=value;
   else if(value&&typeof value.getReader==='function'){
    const reader=value.getReader(),chunks=[];
    while(true){const step=await reader.read();if(step.done)break;chunks.push(Buffer.from(step.value));}
    buf=Buffer.concat(chunks);
   }else buf=Buffer.from(String(value));
   objects.set(key,buf);etags.set(key,'e'+(++revision));return {etag:etags.get(key)};
  },
  async delete(key){objects.delete(key);etags.delete(key);},
  async list({prefix=''}={}){return {objects:[...objects.keys()].filter(key=>key.startsWith(prefix)).map(key=>({key,size:objects.get(key).length})),truncated:false};},
  retained
 };
}
const store=bucket();
await store.put('epg/generations/'+OLD+'/discovery-latest.json',ledgerBuf);
await store.put('epg/discovery-latest.json',ledgerBuf);
await store.put('epg/generations/'+OLD+'/discovered-films.json',catalogBuf);
await store.put('epg/discovered-films.json',catalogBuf);
await store.put('epg/discovery-archive/v1/current.json',Buffer.from(JSON.stringify({manifestId:'manifest-frozen'})));
await store.put('epg/discovery-archive/v1/manifests/manifest-frozen.json',Buffer.from(JSON.stringify(manifest)));
await store.put('epg/discovery-archive/v1/segments/'+reentrySegment+'/write-1.json',Buffer.from(JSON.stringify(segmentBody)));
await store.put('epg/published-generation.json',Buffer.from(JSON.stringify({programmeRunId:OLD,phase:'published'})));
await store.put('titles.json',Buffer.from('{}'));
await store.put('people.json',Buffer.from('{}'));
await store.put('watchlist.json',Buffer.from(JSON.stringify({updatedAt:'2026-11-01T00:00:00.000Z',films:watch})));

const dbFile=path.join(root,'epg.sqlite');
const db=d1Standin(dbFile);
for(const name of ['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state','0005_film_sync_state','0006_metadata_cache','0008_published_epg_authority']){
 if(name==='0008_published_epg_authority')db.sql(fs.readFileSync('migrations/0007_prediction_authority.sql','utf8'));
 db.sql(fs.readFileSync('migrations/'+name+'.sql','utf8'));
}
db.sql("UPDATE published_epg_authority SET mode='d1', cutover='open' WHERE id=1");
const seedWatch={updatedAt:'2026-11-01T00:00:00.000Z',films:watch};
const seedProgramme={runId:OLD,updatedAt:'2026-11-02T00:00:00.000Z',watchlistCount:WATCH,films:[],people:{directors:[],actors:[]},stats:{epgEnd:Date.now()+10*3600000,scanned:100,channels:10,broadcasts:1}};
await call('PublishedEpg.publishGeneration')({DB:db,BUCKET:store},{programmeRunId:OLD,phase:'published',publishedAt:seedProgramme.updatedAt,expectedProgrammeRunId:null,programme:seedProgramme,watchlist:seedWatch});

const xmlTime=t=>new Date(t).toISOString().replace(/[-:T]/g,'').slice(0,14)+' +0000';
const now=Date.now(),start=now+10*3600000;
const xml=['<?xml version="1.0"?><tv>'];
for(let c=0;c<150;c++)xml.push(`<channel id="ch${c}"><display-name>Канал ${c}</display-name></channel>`);
const programme=(title,at)=>`<programme start="${xmlTime(at)}" stop="${xmlTime(at+100*60000)}" channel="ch${xml.length%150}"><title>${title}</title><desc>Описание сеанса</desc></programme>`;
for(const item of watch)xml.push(programme(`${item.original} (${item.year})`,start));
for(let i=0;i<LATEST;i++)xml.push(programme(shown('Кандидат',i),start+(i%20)*60_000));
xml.push('</tv>');
epgBody=xml.join('');
xml.length=0;

if(global.gc)global.gc();
snap('baseline','exit');
const env={BUCKET:store,DB:db,DISCOVERY_LEDGER_MODE:'frozen',LETTERBOXD_USERNAME:'fixture',EPG_XML_URL:'https://epg.invalid/guide.xml'};
const run={runId:RUN,stage:'epg',startedAt:new Date(now).toISOString(),pages:1,pending:[],watchlist:watch};
const started=Date.now();
let error=null,result=null;
try{result=await call('epgSync')(env,run);}
catch(e){error=String(e&&e.stack||e).split('\n').slice(0,6).join(' | ');}
clearInterval(sampler);
const published=db.sql('SELECT programme_run_id AS run, generation FROM published_epg_authority WHERE id=1')[0];
const summary={
 mode:MODE,gcAtMarkers:GC,gcSample:GC_SAMPLE,node:process.version,
 oldSpaceMB:MB(v8.getHeapStatistics().heap_size_limit),
 volumes:{watch:WATCH,catalog:CATALOG,latest:LATEST,ledger:LEDGER,archivedReported:ARCHIVED,ledgerBytes,catalogBytes:catalogBuf.length,reentryKey,reentrySegment},
 error,elapsedMs:Date.now()-started,stage:result?.stage||run.stage||null,
 authority:{run:published?.run||null,generation:published?Number(published.generation):null},
 phases:[...samples.values()]
};
console.log(JSON.stringify(summary));
