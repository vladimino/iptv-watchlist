// AIR-426: offline memory benchmark of the transition from a `frozen` discovery ledger to `bounded`. Synthetic objects only:
// no network, no R2, no D1, no production data. It answers one question the AIR-220 benchmark does not: what the Worker's own
// FIRST bounded commit costs when the frozen ledger has accumulated absent observations (in October 2026 that first commit was
// replaced by an offline split). It builds a frozen store (an archive that exists, an active ledger of `total` observations of
// which `seen` are in the latest scan), then finds the smallest V8 old space (`--max-old-space-size`, MB) at which each of
// these commits completes through the Worker's planner (`publishGenerationWithLedger`):
//   frozen-commit   the commit production runs every day now (the baseline that is known to fit)
//   bounded-first   the first bounded commit with no departure budget: every absent observation departs into the archive in one request
//   bounded-cap-N   the first bounded commit with a departure budget of N backlog observations (AIR-429); the observations that left the scan
//                   since the previous generation (`--churn`) depart at once in every scenario
//   bounded-next    a bounded commit after an uncapped first one
// Object bodies live on disk, so the measured heap holds only what the Worker code materializes. The numbers are relative:
// Node's old-space limit approximates, but is not, the Workers isolate limit. The D1 seal runs in later requests and is not
// part of this measurement (see tests/discovery-bounded-d1-rehearsal.mjs).
//
// Usage: node scripts/discovery-bounded-transition-benchmark.mjs --output /absolute/dir/outside/repo [--total 47059] [--seen 20568] [--archived 18348] [--churn 4818] [--caps 2000,5000,8000] [--caps-only]
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {REPO,directoryBase,loadWorker,overlayStore} from './discovery-ledger-offline.mjs';

const BASE=Date.UTC(2026,10,1,12),DAY=86400000;
const run=day=>'00000000-0000-4000-8000-'+String(day).padStart(12,'0');
// About the production record: a Cyrillic title and description, two shows. The title carries no number that reads as a year.
const RU=['Брат','Сибирский цирюльник','Москва слезам не верит','Ирония судьбы','Кин-дза-дза','Сталкер','Зеркало','Солярис'];
const raw=(i,day)=>{const start=BASE+day*DAY+(i%20)*3600000,title=RU[i%8]+' к'+i.toString(36)+' ('+(1960+i%60)+')';return {key:null,confirmedTmdbId:null,title,rawTitles:[title],normalizedTitle:null,year:1960+i%60,duration:95,description:'Описание фильма '.repeat(40).slice(0,560),firstAiring:start,lastAiring:start,airings:1,shows:[{channelId:'ch'+(i%300),channel:'Канал '+(i%300),start,end:start+5400000,epgTitle:title},{channelId:'d'+(i%40),channel:'Д',start:start+7200000,end:start+9000000,epgTitle:title}]};};
const scan=(count,day,from=0)=>Array.from({length:count},(_,i)=>raw(from+i,day));

async function commit(store,day,mode,latest,cap=null){
 const context=loadWorker(),id=run(day);
 if(cap!==null)context.ledgerDrainCap=()=>cap;
 await store.put('sync.json',JSON.stringify({runId:id,stage:'epg'}));
 await vm.runInContext('publishGenerationWithLedger',context)({BUCKET:store,...(mode?{DISCOVERY_LEDGER_MODE:mode}:{})},id,latest,{programmeRunId:id},{'programme.json':{runId:id,films:[]},'discovered-films.json':{}});
}
async function build(dir,{total,seen,archived,churn}){
 // Day 0: one full ledger of total + archived observations. Day 1, bounded: the scan is the first `total`, so `archived` depart
 // and the archive exists. Day 2, flag unset (frozen): the scan is the first `seen`, so total - seen stay active and absent.
 const base=path.join(dir,'frozen'),store=overlayStore(null,base);
 await commit(store,0,undefined,scan(total+archived,0));
 await commit(store,1,'bounded',scan(total,1));
 await commit(store,2,undefined,scan(seen,2));
 const ledger=JSON.parse(fs.readFileSync(path.join(base,encodeURIComponent('epg/discovery-latest.json')),'utf8'));
 const shape={total,seen,archived,churn,ledgerMode:ledger.ledgerMode,activeItems:ledger.items.length,absentItems:ledger.items.filter(item=>item.seenInLatestSnapshot!==true).length,activeMb:Math.round(fs.statSync(path.join(base,encodeURIComponent('epg/discovery-latest.json'))).size/1e5)/10,archiveItems:ledger.archive?.items??0,archiveMb:Math.round((ledger.archive?.bytes??0)/1e5)/10};
 // The store after the first bounded commit, for `bounded-next`.
 const next=path.join(dir,'bounded');fs.cpSync(base,next,{recursive:true});
 await commit(overlayStore(null,next),3,'bounded',scan(seen,3),Number.MAX_SAFE_INTEGER);
 const after=JSON.parse(fs.readFileSync(path.join(next,encodeURIComponent('epg/discovery-latest.json')),'utf8'));
 shape.afterFirstBounded={ledgerMode:after.ledgerMode,activeItems:after.items.length,activeMb:Math.round(fs.statSync(path.join(next,encodeURIComponent('epg/discovery-latest.json'))).size/1e5)/10,archiveItems:after.archive.items,archiveMb:Math.round(after.archive.bytes/1e5)/10,segments:after.archive.segments};
 fs.writeFileSync(path.join(dir,'shape.json'),JSON.stringify(shape));
 return shape;
}
async function child(scenario,dir){
 const {seen,churn}=JSON.parse(fs.readFileSync(path.join(dir,'shape.json'),'utf8'));
 const capped=/^bounded-cap-(\d+)$/.exec(scenario);
 const [base,mode,day,cap]=scenario==='frozen-commit'?['frozen',undefined,3,null]:scenario==='bounded-first'?['frozen','bounded',3,Number.MAX_SAFE_INTEGER]:capped?['frozen','bounded',3,Number(capped[1])]:['bounded','bounded',4,null];
 const overlay=fs.mkdtempSync(path.join(dir,'run-'));
 // The scan moves by `churn` keys: that many leave it (they were seen in the previous generation) and that many of the backlog re-enter it.
 try{await commit(overlayStore(directoryBase(path.join(dir,base)),overlay),day,mode,scan(seen,day,scenario==='bounded-next'?churn:churn),cap);}
 finally{fs.rmSync(overlay,{recursive:true,force:true});}
}
function minHeap(scenario,dir){
 const once=mb=>{const started=Date.now(),ok=spawnSync(process.execPath,[...(mb?['--max-old-space-size='+mb,'--max-semi-space-size=1']:[]),fileURLToPath(import.meta.url),'--child',scenario,dir],{stdio:'ignore'}).status===0;return {ok,ms:Date.now()-started};};
 const free=once(null);
 if(!free.ok)return {scenario,error:'fails without a limit'};
 let lo=16,hi=1024;while(hi-lo>4){const mid=(lo+hi)>>1;if(once(mid).ok)hi=mid;else lo=mid;}
 return {scenario,minOldSpaceMB:hi,unlimitedMs:free.ms};
}

const args=process.argv.slice(2),value=flag=>{const i=args.indexOf(flag);return i<0?null:args[i+1];};
if(args[0]==='--child'){await child(args[1],args[2]);process.exit(0);}
const output=value('--output');
if(!output||!path.isAbsolute(output)||path.resolve(output).startsWith(REPO+path.sep)){console.error('Usage: node scripts/discovery-bounded-transition-benchmark.mjs --output /absolute/dir/outside/repo [--total 47059] [--seen 20568] [--archived 18348]');process.exit(2);}
const sizes={total:Number(value('--total')||47059),seen:Number(value('--seen')||20568),archived:Number(value('--archived')||18348),churn:Number(value('--churn')||4818)};
const caps=(value('--caps')||'').split(',').filter(Boolean).map(Number);
fs.mkdirSync(output,{recursive:true});
const dir=fs.mkdtempSync(path.join(output,'transition-'));
try{
 const shape=await build(dir,sizes);
 const base=args.includes('--caps-only')?[]:['frozen-commit','bounded-first'],tail=args.includes('--caps-only')?[]:['bounded-next'];
 const results=[...base,...caps.map(cap=>'bounded-cap-'+cap),...tail].map(scenario=>minHeap(scenario,dir));
 console.log(JSON.stringify({shape,results},null,1));
}finally{fs.rmSync(dir,{recursive:true,force:true});}
