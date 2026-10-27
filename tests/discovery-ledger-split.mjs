// AIR-221 / ADR 0034: offline split of a full discovery ledger and its rehearsal on a verified snapshot. A synthetic
// production-shaped snapshot is built from ten days of scans through the Worker's own full-mode merge; the plan must be
// deterministic and lossless, the rehearsal must reach GO, and every stop condition must refuse without a planned write.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {manifestFor} from '../scripts/migration-export.mjs';
import {loadWorker,overlayStore,snapshotBase} from '../scripts/discovery-ledger-offline.mjs';
import {SplitError,applySplit,loadPlan,plan,rehearse} from '../scripts/discovery-ledger-split.mjs';

const sha256=value=>createHash('sha256').update(value).digest('hex');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-ledger-split-'));
const context=loadWorker(),merge=vm.runInContext('mergeDiscoveryCandidates',context);
const DAY=86400000,BASE=Date.UTC(2026,9,20,12),run=day=>'00000000-0000-4000-8000-'+String(day).padStart(12,'0');
const titles=['Брат','Сталкер','Солярис','Зеркало','Кин-дза-дза','Ирония судьбы'];
// Candidate i airs on day d by its pattern: a stable core, regulars, rare titles and one-offs that leave for good.
const airs=(i,d)=>i<40?true:i<120?(d+i)%3!==0:i<180?(i+d)%5===0:d===i%10;
function scan(day,universe=260){
 const out=[];
 for(let i=0;i<universe;i++){
  if(!airs(i,day))continue;
  const start=BASE+day*DAY+(i%12)*3600000,title=(i%23===5?'Сериал ':'')+titles[i%6]+' '+i+' ('+(1960+i%40)+')';
  out.push({key:null,confirmedTmdbId:i%17===0?String(5000+i):null,title,rawTitles:[title+(day%2?' х/ф':'')],normalizedTitle:null,year:1960+i%40,duration:90+(i%5)*5+(day%3),description:'Описание '+i+(day%4===0?' (день '+day+')':''),firstAiring:start,lastAiring:start,airings:1,shows:[{channelId:'ch'+(i%7),channel:'Канал '+(i%7),start,end:start+5400000,epgTitle:title}]});
 }
 return out;
}
let ledgerItems=[];for(let day=0;day<10;day++)ledgerItems=merge(ledgerItems,scan(day),{replaceShows:true,programmeRunId:run(day)});
const P=run(9);
const decisions=Object.fromEntries(ledgerItems.filter((_,i)=>i%3===0).map((item,i)=>[item.key,i%4===0?{status:'verified',tmdbId:String(9000+i)}:i%4===1?{status:'excluded_nonfilm',reason:'show_label'}:i%4===2?{status:'ambiguous'}:{status:'not_found',attempts:2}]));
function bodiesFor(items,overrides={}){
 const ledger={programmeRunId:P,updatedAt:new Date(BASE+9*DAY).toISOString(),rawCandidates:items.length,items};
 return {
  'epg/published-generation.json':{programmeRunId:P,phase:'published'},
  'epg/discovery-latest.json':ledger,
  ['epg/generations/'+P+'/discovery-latest.json']:ledger,
  ['epg/generations/'+P+'/programme.json']:{runId:P,films:[]},
  ['epg/generations/'+P+'/discovered-films.json']:{},
  'programme.json':{runId:P,films:[]},
  'epg/discovered-films.json':{},
  'epg/discovery-resolution.json':decisions,
  'sync.json':{runId:P,stage:'complete'},
  ...overrides
 };
}
function writeSnapshot(name,bodies,{status='consistent_fenced'}={}){
 const directory=path.join(root,name);fs.rmSync(directory,{recursive:true,force:true});fs.mkdirSync(path.join(directory,'objects'),{recursive:true});
 const entries=Object.entries(bodies).filter(([,value])=>value!==undefined).map(([key,value])=>{const bytes=Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value),'utf8');const file=sha256(Buffer.from(key,'utf8'))+'.bin';fs.writeFileSync(path.join(directory,'objects',file),bytes);return {key,file:'objects/'+file,size:bytes.length,sha256:sha256(bytes),metadata:{key,size:bytes.length,etag:'"etag-'+sha256(bytes).slice(0,12)+'"'}};});
 const manifest=manifestFor(entries,1,'2026-10-29T00:00:00.000Z','2026-10-29T01:00:00.000Z',[]);
 Object.assign(manifest,{sourceSiteId:null,sourceOrigin:null,status,noGoReasons:status==='consistent_fenced'?[]:['fence_changed'],source:{kind:'cloudflare-r2-s3',bucket:'iptv',accountId:'0'.repeat(32),endpoint:'example.r2',endpointOverride:true,exporter:'scripts/r2-snapshot-export.mjs',readOnly:true},fence:{ok:status==='consistent_fenced',keys:[]},baselineIdentity:{publishedProgrammeRunId:P,syncUpdatedAt:null,continuationAt:null,continuationHopId:null,latestEnrichmentRunId:null}});
 fs.writeFileSync(path.join(directory,'manifest.json'),JSON.stringify(manifest));
 return directory;
}
const out=name=>{const directory=path.join(root,'out-'+name);fs.rmSync(directory,{recursive:true,force:true});return directory;};
const seen=ledgerItems.filter(item=>item.seenInLatestSnapshot).length;

try{
 assert.ok(seen>40&&ledgerItems.length-seen>40,'the synthetic ledger has both active and departed candidates');
 const snapshot=writeSnapshot('good',bodiesFor(ledgerItems));

 // Plan: ready, lossless partition, deterministic bytes, aggregates only in the report.
 const dirA=out('plan-a'),dirB=out('plan-b'),dirR=out('rehearse');
 const first=await plan({snapshot,output:dirA});
 assert.equal(first.report.verdict,'READY');assert.deepEqual(first.report.stops,[]);
 assert.equal(first.report.active.items,seen);assert.equal(first.report.archived.items,ledgerItems.length-seen);
 assert.equal(first.report.active.items+first.report.archived.items,first.report.source.items);
 assert.ok(first.report.archived.returnable>0&&first.report.archived.decisions.verified>0,'archived decisions are counted by status');
 const second=await plan({snapshot,output:dirB});
 assert.deepEqual(second.plan.writes.map(write=>write.sha256),first.plan.writes.map(write=>write.sha256),'the plan is deterministic');
 assert.deepEqual(first.plan.writes.map(write=>write.kind).slice(-3),['manifest','pointer','active'],'pointer before the active ledger');
 const reportText=fs.readFileSync(path.join(dirA,'plan-report.json'),'utf8');
 for(const item of ledgerItems.slice(0,30))assert.ok(!reportText.includes(item.key)&&!reportText.includes(item.title),'the report carries no key or title');

 // The planned objects are what the Worker reads: counts through ledgerCounts, segments named by the Worker's hash.
 const store=overlayStore(snapshotBase(snapshot,JSON.parse(fs.readFileSync(path.join(snapshot,'manifest.json'),'utf8'))),path.join(root,'apply-1'));
 const planned=loadPlan(dirB);
 const applied=await applySplit({BUCKET:store},planned,{context});
 assert.equal(applied.applied,planned.writes.length);
 const activeLedger=await (await store.get('epg/discovery-latest.json')).json();
 assert.equal(activeLedger.ledgerMode,'bounded');assert.equal(activeLedger.items.length,seen);
 assert.equal(vm.runInContext('ledgerCounts',context)(activeLedger,decisions).ledgerTotal,ledgerItems.length);
 const segmentOf=vm.runInContext('ledgerArchiveSegment',context);
 for(const write of planned.writes.filter(entry=>entry.kind==='segment')){const body=JSON.parse(write.text);for(const key of Object.keys(body.items))assert.equal(segmentOf(key),body.segment);}
 assert.equal((await store.get('epg/generations/'+P+'/discovery-latest.json')).etag,planned.fence.generationCopy.etag,'the generation copy stays the rollback copy');
 assert.equal((await applySplit({BUCKET:store},planned,{context})).applied,0,'a rerun after success writes nothing');

 // A commit that lands between the archive pointer and the active ledger: the split stops, nothing is lost.
 const raced=overlayStore(snapshotBase(snapshot,JSON.parse(fs.readFileSync(path.join(snapshot,'manifest.json'),'utf8'))),path.join(root,'race'));
 await assert.rejects(applySplit({BUCKET:raced},planned,{context,failAfter:planned.writes.length-1}),error=>error.exitCode===9);
 const S=run(10),env={BUCKET:raced,DISCOVERY_LEDGER_MODE:'full'};
 await raced.put('sync.json',JSON.stringify({runId:S,stage:'epg'}));
 await vm.runInContext('publishGenerationWithLedger',context)(env,S,scan(10),{programmeRunId:S},{'programme.json':{runId:S,films:[]}});
 await raced.put('sync.json',JSON.stringify({runId:S,stage:'complete'}));
 await assert.rejects(applySplit({BUCKET:raced},planned,{context}),error=>error instanceof SplitError&&error.exitCode===3,'the stale split refuses');
 const racedLedger=await (await raced.get('epg/discovery-latest.json')).json(),expected=merge(ledgerItems,scan(10),{replaceShows:true,programmeRunId:S});
 assert.equal(racedLedger.ledgerMode,'frozen','a full-mode Worker that meets the archive pointer acts as frozen');
 assert.equal(vm.runInContext('ledgerCounts',context)(racedLedger,decisions).ledgerTotal,expected.length,'unique counts stay exact');
 assert.deepEqual(new Set(racedLedger.items.map(item=>item.key)),new Set(expected.map(item=>item.key)),'no candidate is lost');

 // Rehearsal: GO with every check, and aggregates only.
 const report=await rehearse({snapshot,output:dirR,heap:!!process.env.SPLIT_HEAP});
 assert.equal(report.verdict,'GO',JSON.stringify(report.reasons));
 assert.equal(report.checks.reconstruction.exact,true);assert.equal(report.checks.reconstruction.missing,0);
 assert.equal(report.checks.replay.zeroMutations,true);
 assert.ok(report.checks.resume.length>=4&&report.checks.resume.every(entry=>entry.stopped&&entry.identical));
 assert.ok(Object.values(report.checks.negative).every(entry=>entry.refused&&entry.plannedWrites===0));
 assert.equal(report.checks.nextCommit.parity.exact,true);assert.ok(report.checks.nextCommit.reentered>0,'archived candidates re-enter');
 assert.equal(report.checks.nextCommit.countsExact,true);assert.equal(report.checks.chunk.activeDecisionsDiffer,0);assert.equal(report.checks.chunk.archiveReadsByChunk,0);
 assert.ok(report.plan.archived.screenedWithoutExclusion>0,'archived rows the screening would exclude are counted');
 assert.ok(!fs.existsSync(path.join(dirR,'work')),'the rehearsal removes its working copies');

 // Stops: each refuses the plan (NO-GO) without writing a planned object.
 const stop=async(name,bodies,reason)=>{const dir=out(name),result=await plan({snapshot:writeSnapshot(name,bodies),output:dir});assert.equal(result.report.verdict,'NO-GO',name);assert.ok(result.report.stops.includes(reason),name+': '+result.report.stops);await assert.rejects(applySplit({BUCKET:overlayStore(null,path.join(root,'never-'+name))},loadPlan(dir),{context}),error=>error.exitCode===3);};
 await stop('duplicate',bodiesFor([...ledgerItems,ledgerItems[0]]),'duplicate_keys');
 await stop('unmarked',bodiesFor(ledgerItems.map((item,i)=>{if(i!==2)return item;const {seenInLatestSnapshot,...rest}=item;return rest;})),'unmarked_items');
 await stop('mismatch',bodiesFor(ledgerItems.map(item=>item.seenInLatestSnapshot?{...item,lastSeenProgrammeRunId:run(3)}:item)),'active_run_mismatch');
 await stop('copy',bodiesFor(ledgerItems,{['epg/generations/'+P+'/discovery-latest.json']:{programmeRunId:P,items:[]}}),'root_differs_from_generation');
 await stop('archived',bodiesFor(ledgerItems,{'epg/discovery-archive/v1/current.json':{manifestId:'x'}}),'already_split');
 const rehearsed=await rehearse({snapshot:writeSnapshot('duplicate-r',bodiesFor([...ledgerItems,ledgerItems[0]])),output:out('duplicate-r')});
 assert.equal(rehearsed.verdict,'NO-GO');assert.deepEqual(rehearsed.reasons,['plan_stops']);
 await assert.rejects(plan({snapshot:writeSnapshot('nogo',bodiesFor(ledgerItems),{status:'no_go'}),output:out('nogo')}),error=>error.exitCode===3,'a NO-GO snapshot is refused');
 await assert.rejects(plan({snapshot,output:path.join(process.cwd(),'tmp-split')}),error=>error.exitCode===2,'output inside the repository is refused');
 console.log('discovery ledger split: ok');
}finally{fs.rmSync(root,{recursive:true,force:true});}
