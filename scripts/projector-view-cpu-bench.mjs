// Offline CPU profile of the D1 enrichment projector's view build (the CPU-only stretch between the last D1 read and the first D1 read that follows it in
// d1EnrichmentDiff). Not bundled, never run by CI or by any production path: it reads no R2, no D1, no network and no production payload; every input is a
// deterministic synthetic fixture. It runs the REAL code of the Worker bundle (src/domain/film-person-reader.js, src/enrichment-projection.js,
// src/owner-review-d1.js) loaded by tests/d1-enrichment-context.mjs, in the call order of d1EnrichmentDiff:
//   lifecycle  = LifecycleReader.readLifecycle(store, now, {entitiesOnly:true})
//   overlay    = OwnerReview.applyViewOverlay(view, ownerReviews)
//   inputs     = EnrichmentProjection.enrichmentInputs({view, store})
//   keys       = personChangeKey / filmChangeKey of every input (JSON.stringify + two 53-bit hashes)
// What it measures: for each phase wall time (process.hrtime), CPU time (process.cpuUsage, user + system), V8 GC time (perf_hooks), and heap growth, over warm-ups and
// repeats, on freshly cloned store objects each repeat (the reader caches indexes per source object in a WeakMap, so reusing a store would hide the cold cost the
// projector pays on every run). The scaling run repeats it at several sizes and fits the log-log slope of the median time against the entity count (1 is linear,
// 2 is quadratic). `--profile` adds a V8 sampling profile of the whole build and lists the functions with the most self time.
// What it does NOT measure: Cloudflare Worker CPU (a different machine and runtime), the clock semantics of Date.now() inside a Worker, R2 JSON parsing, the D1
// metadata-cache transform, any I/O, or production data. A time here says what this code costs on this machine; it does not say what the Worker spent.
//   node --expose-gc scripts/projector-view-cpu-bench.mjs [--impl baseline|indexed] [--entities 52000] [--sizes 6500,13000,26000,52000,104000] [--repeats 7] [--warmup 2] [--profile 1] [--keys-breakdown 1] [--only 1] [--vm 1]
import fs from 'node:fs';
import os from 'node:os';
import inspector from 'node:inspector';
import vm from 'node:vm';
import {scoped} from './bundle-scope.mjs';
import {PerformanceObserver,constants} from 'node:perf_hooks';
import {pathToFileURL} from 'node:url';
import {projectorContext} from '../tests/d1-enrichment-context.mjs';

const arg=(name,fallback)=>{const at=process.argv.indexOf('--'+name);return at>0?process.argv[at+1]:fallback;};
const toNumber=(value,fallback)=>Number.isFinite(Number(value))?Number(value):fallback;

// ---- deterministic synthetic fixture -----------------------------------------------------------------------------------------------------
function rng(seed){let a=seed>>>0;return()=>{a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
const T='2026-10-28T10:00:00.000Z';
const NOW=Date.parse('2026-11-09T22:00:00.000Z');
const FIRST=['robert','jean','maria','anna','john','luis','sofia','kim','omar','elena'];
// `entities` counts what the view holds: Films plus the Persons they credit. The mix follows the 2026-11-09 production sizes (about 48,500 entities, about a fifth of them
// Films, a few hundred on the watchlist, the rest the discovered-film catalog; 12.2 credits a Film). Every Person is credited at least once, the rest reuse a skewed pool.
export function fixture(entities,{seed=7}={}){
 const random=rng(seed);
 const films=Math.round(entities*0.19),persons=entities-films;
 const watch=Math.max(20,Math.round(films*0.04));
 const pool=[];
 for(let index=0;index<persons;index++){
  const id=index%4===0?'actor/'+FIRST[index%FIRST.length]+'-'+index.toString(36):index%2?'tmdb_actor/'+(1000+index):'tmdb_director/'+(1000+index);
  pool.push({id,name:'Person '+index,original:'Person '+index});
 }
 let cursor=0;
 const pick=()=>{if(cursor<pool.length)return pool[cursor++];const skew=random();return pool[Math.floor(skew*skew*pool.length)];};
 const credits=(index,count)=>{const actors=[];for(let k=0;k<count;k++)actors.push(pick());return {directors:[pick()],actors};};
 const sizeOf=()=>{const u=random();return u<0.75?11:u<0.95?6:35;};
 const watchlist=[],programme=[],metadata={},discovered={};
 for(let index=0;index<films;index++){
  const roster=credits(index,sizeOf());
  if(index<watch){
   const id='w'+index.toString(36);
   const record={id,title:'Film '+index,original:'Film '+index,year:1980+index%40,tmdbId:String(100000+index),url:'https://letterboxd.com/film/'+id+'/',...roster};
   watchlist.push(record);programme.push({...record,shows:[]});
   metadata[id]={...record,metadataAt:T,peopleVersion:1,peopleNamesVersion:2,synopsis:'Synopsis of '+id,synopsisFetchedAt:T,runtime:90+index%60};
  }else{
   const id='tmdb_'+(200000+index);
   discovered[id]={id,tmdbId:String(200000+index),title:'Catalog '+index,original:'Catalog '+index,year:1950+index%70,discoveredAt:T,synopsis:'Overview '+index,...roster};
  }
 }
 // owner reviews: a few hundred Films and Persons with a reviewed localization, as an owner would have
 const reviews={contractVersion:1,films:{},people:{}};
 for(let index=0;index<Math.min(200,watch);index++)reviews.films['film:w'+index.toString(36)]={localization:{value:'Reviewed '+index,status:'reviewed',source:'owner',authority:'owner',updatedAt:T}};
 for(let index=0;index<Math.min(300,persons);index+=Math.max(1,Math.floor(persons/300)))reviews.people['person:'+pool[index].id]={localization:{value:'Reviewed person '+index,status:'reviewed',source:'owner',authority:'owner',updatedAt:T}};
 return {raw:{watchlist:{updatedAt:T,films:watchlist},programme:{updatedAt:T,films:programme},metadata,discovered,reviews},counts:{films,persons,watchlist:watchlist.length,catalog:Object.keys(discovered).length,metadata:Object.keys(metadata).length}};
}

// How the code is loaded matters a great deal. The test helper (tests/d1-enrichment-context.mjs) runs the bundle's sources inside vm.createContext(); a global read there
// (Math.imul in the hash loop, JSON, Map) goes through the sandbox's property interceptor, which is far slower than in the Worker, where the bundle is plain script
// scope. The default here loads the same sources the same way the bundle carries them but in the ordinary global context (vm.runInThisContext); `--vm 1` loads them
// through the sandboxed test context, to show how large that harness effect is. Neither is the Worker, but only the first resembles its global access.
function directModules(){
 vm.runInThisContext(fs.readFileSync('src/domain/film-person.js','utf8')+'\n'+fs.readFileSync('src/domain/tmdb-tv-identity.js','utf8'));
 // AIR-402: `--impl baseline` runs the frozen copies of the reader and the projection from before the linear indexes (tests/fixtures/air-402-baseline/, d73ac48), `--impl indexed` (the default) the current sources
 vm.runInThisContext(scoped(BASELINE?'tests/fixtures/air-402-baseline/film-person-reader.baseline.js':'src/domain/film-person-reader.js','LifecycleReader',['readLifecycle']));
 vm.runInThisContext(scoped(BASELINE?'tests/fixtures/air-402-baseline/enrichment-projection.baseline.js':'src/enrichment-projection.js','EnrichmentProjection'));
 vm.runInThisContext(scoped('src/owner-review-d1.js','OwnerReview'));
 return vm.runInThisContext('({LifecycleReader,EnrichmentProjection,OwnerReview})');
}
const SANDBOXED=arg('vm','0')==='1';
const BASELINE=arg('impl','indexed')==='baseline';
const projector=SANDBOXED?projectorContext({log:()=>{}}):directModules();
const DICTIONARIES={films:JSON.parse(fs.readFileSync('data/film-titles.json','utf8')),people:JSON.parse(fs.readFileSync('data/person-names.json','utf8'))};
const clone=value=>JSON.parse(JSON.stringify(value));
// The store the projector hands to the reader, built from freshly cloned objects (cold per-object caches), the same way d1EnrichmentStore builds it.
function storeFrom(raw){
 const copy=clone(raw);
 const store=projector.EnrichmentProjection.enrichmentStore({watchlist:copy.watchlist,programme:copy.programme,metadata:copy.metadata,titles:{},people:{},discoveredFilms:copy.discovered,discoveryResolution:{},diaryHistory:null,tmdbRetirements:null,watchlistAdmissions:null,archiveAdmissions:null,filmTitles:DICTIONARIES.films,personNames:DICTIONARIES.people,personOverrides:{}});
 store.ownerReviews=copy.reviews;
 return store;
}

// ---- measurement ---------------------------------------------------------------------------------------------------------------------------
let gcMs=0;
const observer=new PerformanceObserver(list=>{for(const entry of list.getEntries())gcMs+=entry.duration;});
observer.observe({entryTypes:['gc']});
const flushGc=async()=>{await new Promise(resolve=>setImmediate(resolve));};
async function measured(fn){
 if(global.gc)global.gc();
 await flushGc();
 const gc0=gcMs,heap0=process.memoryUsage().heapUsed,cpu0=process.cpuUsage(),at=process.hrtime.bigint();
 const value=fn();
 const wall=Number(process.hrtime.bigint()-at)/1e6,cpu=process.cpuUsage(cpu0);
 const heap1=process.memoryUsage().heapUsed;
 await flushGc();
 return {value,wallMs:wall,cpuMs:(cpu.user+cpu.system)/1000,gcMs:gcMs-gc0,heapMb:(heap1-heap0)/1048576};
}
// One full build, phase by phase, in the call order of d1EnrichmentDiff.
async function build(raw){
 const store=storeFrom(raw);
 const out={};
 const lifecycle=await measured(()=>projector.LifecycleReader.readLifecycle(store,NOW,{entitiesOnly:true}));out.lifecycle=lifecycle;
 const view=lifecycle.value;
 out.overlay=await measured(()=>projector.OwnerReview.applyViewOverlay(view,store.ownerReviews));
 const inputs=await measured(()=>projector.EnrichmentProjection.enrichmentInputs({view,store}));out.inputs=inputs;
 const nowIso=new Date(NOW).toISOString();
 out.keys=await measured(()=>{const map=new Map();for(const entry of inputs.value.people)map.set(entry,projector.EnrichmentProjection.personChangeKey(entry,nowIso));for(const entry of inputs.value.films)map.set(entry,projector.EnrichmentProjection.filmChangeKey(entry,nowIso));return map;});
 const sizes={films:view.films.length,people:view.people.length,keys:out.keys.value.size};
 for(const phase of Object.values(out))delete phase.value;
 return {phases:out,sizes};
}
const percentile=(values,p)=>{const sorted=[...values].sort((a,b)=>a-b);if(!sorted.length)return null;const at=(sorted.length-1)*p,low=Math.floor(at),high=Math.ceil(at);return sorted[low]+(sorted[high]-sorted[low])*(at-low);};
const summarize=values=>({n:values.length,median:+percentile(values,0.5).toFixed(2),min:+Math.min(...values).toFixed(2),max:+Math.max(...values).toFixed(2),iqr:+(percentile(values,0.75)-percentile(values,0.25)).toFixed(2),cv:+((Math.sqrt(values.reduce((t,v)=>t+(v-values.reduce((a,b)=>a+b,0)/values.length)**2,0)/values.length))/(values.reduce((a,b)=>a+b,0)/values.length||1)).toFixed(3)});
export async function runSize(entities,{repeats=7,warmup=2}={}){
 const {raw,counts}=fixture(entities);
 const runs=[];let sizes=null;
 for(let index=0;index<warmup+repeats;index++){
  const result=await build(raw);
  sizes=result.sizes;
  if(index>=warmup)runs.push(result.phases);
 }
 const phases={};
 for(const name of ['lifecycle','overlay','inputs','keys']){
  phases[name]={};
  for(const metric of ['wallMs','cpuMs','gcMs','heapMb'])phases[name][metric]=summarize(runs.map(run=>run[name][metric]));
 }
 const total=runs.map(run=>Object.values(run).reduce((t,phase)=>t+phase.wallMs,0));
 const totalCpu=runs.map(run=>Object.values(run).reduce((t,phase)=>t+phase.cpuMs,0));
 return {requested:entities,counts,view:sizes,entities:sizes.films+sizes.people,repeats,warmup,phases,total:{wallMs:summarize(total),cpuMs:summarize(totalCpu)}};
}
// log-log slope of the median wall time against the entity count (least squares)
export function slope(points){
 const xs=points.map(point=>Math.log(point.x)),ys=points.map(point=>Math.log(point.y));
 const mx=xs.reduce((a,b)=>a+b,0)/xs.length,my=ys.reduce((a,b)=>a+b,0)/ys.length;
 return +(xs.reduce((t,x,i)=>t+(x-mx)*(ys[i]-my),0)/xs.reduce((t,x)=>t+(x-mx)**2,0)).toFixed(2);
}
// V8 sampling profile of one whole build: the functions with the most self time (microseconds), by function name and source line.
export async function profileBuild(entities,{top=14}={}){
 const {raw}=fixture(entities);
 const session=new inspector.Session();session.connect();
 const post=(method,params)=>new Promise((resolve,reject)=>session.post(method,params,(error,result)=>error?reject(error):resolve(result)));
 await post('Profiler.enable');await post('Profiler.setSamplingInterval',{interval:250});
 const store=storeFrom(raw);
 await post('Profiler.start');
 const view=projector.LifecycleReader.readLifecycle(store,NOW,{entitiesOnly:true});
 projector.OwnerReview.applyViewOverlay(view,store.ownerReviews);
 const inputs=projector.EnrichmentProjection.enrichmentInputs({view,store});
 const nowIso=new Date(NOW).toISOString();
 for(const entry of inputs.people)projector.EnrichmentProjection.personChangeKey(entry,nowIso);
 for(const entry of inputs.films)projector.EnrichmentProjection.filmChangeKey(entry,nowIso);
 const {profile}=await post('Profiler.stop');session.disconnect();
 const byId=new Map(profile.nodes.map(node=>[node.id,node]));
 const self=new Map();
 profile.samples.forEach((id,index)=>{const node=byId.get(id),frame=node.callFrame,key=(frame.functionName||'(anonymous)')+' '+(frame.url.split('/').pop()||'native')+':'+(frame.lineNumber+1);self.set(key,(self.get(key)||0)+(profile.timeDeltas[index]||0));});
 const total=[...self.values()].reduce((a,b)=>a+b,0);
 return {sampledMs:+(total/1000).toFixed(0),top:[...self.entries()].sort((a,b)=>b[1]-a[1]).slice(0,top).map(([name,us])=>({fn:name,selfMs:+(us/1000).toFixed(0),share:+(us/total).toFixed(3)}))};
}
// Where the time of the key phase goes, on the headline inputs: JSON.stringify with the replacer projectionKey passes (a function call per visited value), the same
// stringify without a replacer, and the two 53-bit hash passes over the text. hash53 below is a copy of the one in src/enrichment-projection.js, used only to time the
// hash passes in isolation; the copy is checked against projectionKey on every entry so the breakdown cannot drift from the real function.
function hash53(text,seed){
 let h1=0xdeadbeef^seed,h2=0x41c6ce57^seed;
 for(let i=0;i<text.length;i++){const c=text.charCodeAt(i);h1=Math.imul(h1^c,2654435761);h2=Math.imul(h2^c,1597334677);}
 h1=Math.imul(h1^(h1>>>16),2246822507)^Math.imul(h2^(h2>>>13),3266489909);
 h2=Math.imul(h2^(h2>>>16),2246822507)^Math.imul(h1^(h1>>>13),3266489909);
 return (4294967296*(2097151&h2)+(h1>>>0)).toString(16).padStart(14,'0');
}
export async function keysBreakdown(entities,{repeats=5}={}){
 const {raw}=fixture(entities);
 const store=storeFrom(raw);
 const view=projector.LifecycleReader.readLifecycle(store,NOW,{entitiesOnly:true});
 projector.OwnerReview.applyViewOverlay(view,store.ownerReviews);
 const inputs=projector.EnrichmentProjection.enrichmentInputs({view,store});
 const nowIso=new Date(NOW).toISOString();
 const subjects=[...inputs.people.map(entry=>entry.person),...inputs.films.map(entry=>({film:entry.film,watchlist:entry.watchlist,credits:entry.credits??null,metadata:entry.metadata}))];
 const replacer=(key,value)=>value===nowIso?'@now':value;
 const texts=subjects.map(subject=>JSON.stringify(subject,replacer));
 const plain=subjects.map(subject=>JSON.stringify(subject));
 const identical=texts.every((text,index)=>text===plain[index]);
 // the copy of hash53 reproduces projectionKey exactly
 const agree=subjects.slice(0,2000).every((subject,index)=>projector.EnrichmentProjection.projectionKey(subject,nowIso)==='1:'+texts[index].length+':'+hash53(texts[index],1)+hash53(texts[index],2));
 const time=fn=>{const at=process.hrtime.bigint();fn();return Number(process.hrtime.bigint()-at)/1e6;};
 const samples={asIs:[],stringifyReplacer:[],stringifyPlain:[],hashTwoPasses:[]};
 for(let index=0;index<repeats+1;index++){
  if(global.gc)global.gc();
  const run={
   asIs:time(()=>{for(const subject of subjects)projector.EnrichmentProjection.projectionKey(subject,nowIso);}),
   stringifyReplacer:time(()=>{for(const subject of subjects)JSON.stringify(subject,replacer);}),
   stringifyPlain:time(()=>{for(const subject of subjects)JSON.stringify(subject);}),
   hashTwoPasses:time(()=>{for(const text of texts){hash53(text,1);hash53(text,2);}}),
  };
  if(index>0)for(const name of Object.keys(run))samples[name].push(run[name]);
 }
 const chars=texts.map(text=>text.length);
 const total=chars.reduce((a,b)=>a+b,0);
 const byKind=kind=>{const list=kind==='person'?chars.slice(0,inputs.people.length):chars.slice(inputs.people.length);return {entities:list.length,meanChars:Math.round(list.reduce((a,b)=>a+b,0)/Math.max(1,list.length)),maxChars:Math.max(...list),totalChars:list.reduce((a,b)=>a+b,0)};};
 return {entities:subjects.length,totalChars:total,persons:byKind('person'),films:byKind('film'),replacerChangesNothing:identical,hashCopyMatchesProjectionKey:agree,
  ms:Object.fromEntries(Object.entries(samples).map(([name,values])=>[name,summarize(values)])),
  nsPerChar:{stringifyReplacer:+(percentile(samples.stringifyReplacer,0.5)*1e6/total).toFixed(1),stringifyPlain:+(percentile(samples.stringifyPlain,0.5)*1e6/total).toFixed(1),hashTwoPasses:+(percentile(samples.hashTwoPasses,0.5)*1e6/total).toFixed(1)}};
}
async function main(){
 if(arg('keys-breakdown','0')==='1'&&arg('only','0')==='1'){console.log(JSON.stringify({environment:{loading:SANDBOXED?'vm.createContext (sandboxed test helper)':'vm.runInThisContext (ordinary global scope)',node:process.version,gcExposed:!!global.gc},keysBreakdown:await keysBreakdown(toNumber(arg('entities',52000),52000),{repeats:toNumber(arg('repeats',5),5)})},null,1));return;}
 const sizes=String(arg('sizes','6500,13000,26000,52000,104000')).split(',').map(Number).filter(Boolean);
 const repeats=toNumber(arg('repeats',7),7),warmup=toNumber(arg('warmup',2),2);
 const headline=toNumber(arg('entities',52000),52000);
 if(!sizes.includes(headline))sizes.push(headline);
 sizes.sort((a,b)=>a-b);
 const environment={implementation:BASELINE?'baseline (frozen d73ac48 copies)':'indexed (current src)',loading:SANDBOXED?'vm.createContext (sandboxed test helper)':'vm.runInThisContext (ordinary global scope)',node:process.version,v8:process.versions.v8,platform:process.platform+' '+process.arch,cpu:os.cpus()[0]?.model,cores:os.cpus().length,gcExposed:!!global.gc};
 const results=[];
 for(const size of sizes){results.push(await runSize(size,{repeats,warmup}));process.stderr.write('size '+size+' done\n');}
 const scaling={};
 for(const phase of ['lifecycle','overlay','inputs','keys'])scaling[phase]=slope(results.map(result=>({x:result.entities,y:Math.max(0.01,result.phases[phase].wallMs.median)})));
 scaling.total=slope(results.map(result=>({x:result.entities,y:result.total.wallMs.median})));
 const out={environment,sizes:results,scalingSlope:scaling};
 if(arg('profile','0')==='1')out.profile=await profileBuild(headline);
 if(arg('keys-breakdown','0')==='1')out.keysBreakdown=await keysBreakdown(headline);
 console.log(JSON.stringify(out,null,1));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
