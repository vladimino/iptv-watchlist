// AIR-263: offline memory profile of the EPG commit tail with the Diary stage, on synthetic objects sized like production.
// Run after `npm run build`:  node --expose-gc scripts/epg-memory-profile.mjs [--gc-at-markers] [--concurrency 2]
// It evaluates the built Worker bundle in a vm context against an in-memory bucket (bodies kept as Buffers, outside the JS
// heap), replays the committed-run path (generation copy, finish sync, prediction queue, Diary page 1 and its facts) and
// samples process.memoryUsage() per `epg_phase` marker. No network, no R2, no private data. Node heap is not workerd's
// 128 MB isolate limit; the numbers rank phases, they do not reproduce the production limit.
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';

const args=process.argv.slice(2),flag=name=>args.includes(name),value=(name,fallback)=>{const i=args.indexOf(name);return i>=0?args[i+1]:fallback;};
const FULL=flag('--full'),GC_AT_MARKERS=flag('--gc-at-markers'),CONCURRENCY=Number(value('--concurrency','1')),SCALE=Number(value('--scale','1'));
// Production object sizes read from an R2 LIST (metadata only) on 2026-10-30; see the dated evidence.
const SIZES={'epg/discovery-latest.json':36072532,'epg/discovered-films.json':6222569,'enrichment/view-index.json':6422128,'programme.json':2242013,'watchlist.json':1477694,'metadata.json':1164689,'epg/discovery-resolution.json':1552986,'people.json':223626};
const MB=bytes=>Math.round(bytes/1048576*10)/10;
if(!fs.existsSync('dist/server/index.js')){console.error('Run npm run build first');process.exit(2);}

// Synthetic bodies of a target JSON size: arrays or maps of records shaped like the real objects, padded with text.
const pad=n=>'x'.repeat(n);
function fill(target,make){const out=[];let size=2;for(let i=0;size<target*SCALE;i++){const item=make(i);size+=JSON.stringify(item).length+1;out.push(item);}return out;}
const film=i=>({id:'lid'+i,title:'Film '+i,original:'Film '+i,year:1990+i%30,url:`https://letterboxd.com/film/film-${i}/`,tmdbId:String(1000+i),genres:['Drama'],runtime:100,synopsis:pad(600),directors:[{id:'director/d'+i,name:'D'}],actors:Array.from({length:8},(_,j)=>({id:`actor/a${i}-${j}`,name:'A'})),metadataAt:'2026-10-20T00:00:00.000Z',peopleVersion:1,peopleNamesVersion:2,synopsisFetchedAt:'2026-10-20T00:00:00.000Z'});
const show=(i,j)=>({channelId:'ch'+j,channel:'Channel '+j,start:Date.now()+j*3600000,end:Date.now()+j*3600000+6000000,epgTitle:'Film '+i});
// --full: the whole commit from the EPG scan. The previous published generation holds the ledger and catalog; the new
// EPG is a synthetic XMLTV stream with a broadcast for each watchlist film and many unknown films (discovery).
const xmlTime=t=>{const d=new Date(t);return d.toISOString().replace(/[-:T]/g,'').slice(0,14)+' +0000';};
function epgXml(watch,programmes){
 const now=Date.now(),parts=['<?xml version="1.0"?><tv>'];
 for(let c=0;c<150;c++)parts.push(`<channel id="ch${c}"><display-name>Channel ${c}</display-name></channel>`);
 for(let i=0;i<programmes;i++){const start=now-70*3600000+(i%2000)*3000000/20,known=i%10===0?watch[(i/10)%watch.length]:null,title=known?`${known.original} (${known.year})`:`Unknown Film ${i%9000} (${1950+i%60})`;
  parts.push(`<programme start="${xmlTime(start)}" stop="${xmlTime(start+(known?known.runtime:100)*60000)}" channel="ch${i%150}"><title>${title}</title><desc>${pad(300)}</desc></programme>`);}
 parts.push('</tv>');return parts.join('');
}
function buildStore(runId){
 const watch=fill(SIZES['watchlist.json'],film).slice(0,396);
 const programmeFilms=watch.map((f,i)=>({...f,shows:Array.from({length:6},(_,j)=>show(i,j))}));
 const report={runId,updatedAt:new Date().toISOString(),watchlistCount:programmeFilms.length,films:programmeFilms,people:[],stats:{}};
 const ledger={programmeRunId:runId,updatedAt:report.updatedAt,items:fill(SIZES['epg/discovery-latest.json'],i=>({key:'title '+i+'|2001',title:'Title '+i,normalizedTitle:'title '+i,year:2001,duration:100,description:pad(400),firstAiring:1,lastAiring:2,airings:3,shows:Array.from({length:3},(_,j)=>show(i,j)),rawTitles:['Title '+i]}))};
 const catalog=Object.fromEntries(fill(SIZES['epg/discovered-films.json'],i=>({...film(i),id:'tmdb_'+i,catalog:true})).map(f=>[f.id,f]));
 const viewIndex=Object.fromEntries(fill(SIZES['enrichment/view-index.json'],i=>({id:'lid'+i,actualRating:i%10/2||null,watched:true,prediction:{predictedRating:3.5,probability4Plus:0.4,confidence:'medium',mainRisk:pad(200),matchSignals:['a','b']},fingerprint:{plotMechanics:['heist'],execution:{pace:'slow'}},moodFacet:{labels:['calm']}})).map(e=>[e.id,e]));
 const metadata=Object.fromEntries(fill(SIZES['metadata.json'],film).map(f=>[f.id,f]));
 if(FULL){const prev='prev-run';return {report,objects:{
  'programme.json':{...report,runId:prev},'watchlist.json':{updatedAt:'2026-10-29T00:00:00.000Z',films:watch},'metadata.json':metadata,'enrichment/view-index.json':viewIndex,
  'epg/published-generation.json':{programmeRunId:prev,phase:'published'},
  [`epg/generations/${prev}/discovery-latest.json`]:{...ledger,programmeRunId:prev},[`epg/generations/${prev}/discovered-films.json`]:catalog,[`epg/generations/${prev}/programme.json`]:{...report,runId:prev},
  'letterboxd/facts/links.json':Object.fromEntries(watch.map(f=>['letterboxd:'+f.id,'lb-'+f.id]))
 },watch};}
 return {report,objects:{
  'programme.json':report,'watchlist.json':{updatedAt:'2026-10-29T00:00:00.000Z',films:watch},'metadata.json':metadata,'enrichment/view-index.json':viewIndex,
  'epg/published-generation.json':{programmeRunId:runId,phase:'published'},
  [`epg/generations/${runId}/discovery-latest.json`]:ledger,[`epg/generations/${runId}/discovered-films.json`]:catalog,[`epg/generations/${runId}/programme.json`]:report,
  'letterboxd/facts/links.json':Object.fromEntries(watch.map(f=>['letterboxd:'+f.id,'lb-'+f.id]))
 },watch};
}
// The diary page: fifty rows in the parsed structure, padded to a realistic page size.
const diaryRow=i=>{const d=String(1+i%28).padStart(2,'0');return `<tr class="diary-entry-row"><td><a href="/owner/diary/films/for/2026/10/${d}/">${d}</a></td><td><div data-postered-identifier="{&quot;lid&quot;:&quot;lid${i}&quot;}"></div><h3><a href="/owner/film/film-${i}/">t</a></h3></td><td><span class="rating rated-${1+i%10}"></span></td><td>${pad(2500)}</td></tr>`;};
const diaryHtml='<html><head><title>Diary</title></head><body><table>'+Array.from({length:50},(_,i)=>diaryRow(i)).join('')+'</table><a class="next" href="#">Older</a></body></html>';

function bucketFor(objects){
 const bodies=new Map(Object.entries(objects).map(([key,value])=>[key,Buffer.from(JSON.stringify(value))]));let revision=0;const etags=new Map();
 const tick=()=>new Promise(resolve=>setImmediate(resolve));
 return {
  async get(key){await tick();const body=bodies.get(key);if(!body)return null;return {etag:etags.get(key)||'e0',size:body.length,json:async()=>JSON.parse(body.toString()),text:async()=>body.toString()};},
  async put(key,value,options={}){await tick();const condition=options.onlyIf;if(condition?.etagDoesNotMatch==='*'&&bodies.has(key)||condition?.etagMatches&&condition.etagMatches!==(etags.get(key)||'e0'))return null;bodies.set(key,Buffer.from(typeof value==='string'?value:String(value)));etags.set(key,'e'+(++revision));return {etag:etags.get(key)};},
  async delete(key){bodies.delete(key);},
  async list({prefix=''}={}){await tick();return {objects:[...bodies.keys()].filter(key=>key.startsWith(prefix)).map(key=>({key,size:bodies.get(key).length})),truncated:false};}
 };
}

const samples=new Map();let phase='start';
const record=(name,edge)=>{
 if(GC_AT_MARKERS&&global.gc)global.gc();
 const m=process.memoryUsage(),entry=samples.get(name)||{phase:name,peakHeapMB:0,peakRssMB:0,heapAtEnterMB:null,heapAtExitMB:null,externalMB:0};
 if(edge==='enter')entry.heapAtEnterMB=MB(m.heapUsed);else entry.heapAtExitMB=MB(m.heapUsed);
 entry.peakHeapMB=Math.max(entry.peakHeapMB,MB(m.heapUsed));entry.peakRssMB=Math.max(entry.peakRssMB,MB(m.rss));entry.externalMB=Math.max(entry.externalMB,MB(m.external+m.arrayBuffers));
 samples.set(name,entry);
};
const sampler=setInterval(()=>{const m=process.memoryUsage(),entry=samples.get(phase);if(entry){entry.peakHeapMB=Math.max(entry.peakHeapMB,MB(m.heapUsed));entry.peakRssMB=Math.max(entry.peakRssMB,MB(m.rss));}},1);
const ctx=vm.createContext({Response,Request,Headers,URL,URLSearchParams,Date,Map,Set,JSON,TextEncoder,TextDecoder,Uint8Array,ArrayBuffer,AbortSignal,AbortController,crypto:webcrypto,structuredClone,ReadableStream,setTimeout,clearTimeout,Promise,
 console:{...console,log:line=>{try{const entry=JSON.parse(String(line));if(entry.event==='epg_phase'){phase=entry.phase;record(entry.phase,entry.edge);}}catch{}}},
 fetch:async url=>String(url).includes('/diary/')?new Response(diaryHtml,{status:200}):String(url).startsWith('https://epg.invalid/')?new Response(epgBody,{status:200}):new Response('',{status:404})});
let epgBody='';
vm.runInContext(fs.readFileSync('dist/server/index.js','utf8').replace('export const DiscoveryContinuation=','globalThis.DiscoveryContinuation=').replace('export default','globalThis.worker='),ctx);

async function one(index){
 const runId='profile-run-'+index;let {report,objects,watch}=buildStore(runId);
 if(FULL)epgBody=epgXml(watch,Number(value('--programmes','40000')));
 const env={LETTERBOXD_USERNAME:'owner',EPG_XML_URL:'https://epg.invalid/guide.xml',BUCKET:bucketFor(objects),PUBLISHED_EPG_DB_OPTIONAL:'standin',LETTERBOXD_DIARY_HISTORY:'on',LETTERBOXD_FACTS:'on',DISCOVERY_LEDGER_MODE:'frozen'};
 objects=null;
 const run={runId,stage:'epg',startedAt:new Date().toISOString(),watchlist:watch,pending:[],ratingPending:['letterboxd-diary'],...(FULL?{}:{events:[{id:runId+'-watchlist',type:'watchlist',at:report.updatedAt,total:watch.length,baseline:false,added:[],removed:[]},{id:runId+'-epg',type:'epg',at:report.updatedAt,films:watch.length,archive:0,future:0,broadcasts:0}]}),watchlistObservedAt:report.updatedAt};
 report=null;
 await env.BUCKET.put('sync.json',JSON.stringify(run));
 if(global.gc)global.gc();record('baseline','exit');
 const started=Date.now();let result,error=null;try{result=await ctx.epgSync(env,run);}catch(e){error=String(e.message).slice(0,200);}
 epgBody='';
 return {error,elapsedMs:Date.now()-started,stage:result?.stage,diary:run.diaryHistory?.outcome,facts:run.diaryHistory?.facts?.written};
}
const results=await Promise.all(Array.from({length:CONCURRENCY},(_,i)=>one(i)));
clearInterval(sampler);
const order=['baseline','epg_input_scan','generation_publish','generation_copy','finish_sync','queue_refresh','diary_state_load','diary_page_fetch','diary_page_parse','diary_history_merge','diary_facts_apply','diary_facts_result','diary_state_save','removal'];
const table=[...samples.values()].sort((a,b)=>(order.indexOf(a.phase)+1||99)-(order.indexOf(b.phase)+1||99));
console.log(JSON.stringify({full:FULL,gcAtMarkers:GC_AT_MARKERS,concurrency:CONCURRENCY,scale:SCALE,inputMB:Object.fromEntries(Object.entries(SIZES).map(([k,v])=>[k,MB(v*SCALE)])),diaryPageKB:Math.round(diaryHtml.length/1024),results,phases:table},null,1));
