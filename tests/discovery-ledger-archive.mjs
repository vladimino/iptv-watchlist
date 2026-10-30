// AIR-220 / ADR 0034: bounded discovery ledger with a write-once segmented archive. The same daily scans run through a
// `full`-mode store and a `bounded`-mode store; the bounded active ledger plus its archive must hold exactly the full ledger
// (payload parity), while the active ledger holds only the latest scan. Kill windows, fences, frozen mode, status counts,
// gated routes and the read boundary of chunks and status are covered as well.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';

function makeStore(){
 const records=new Map(),etags=new Map(),gets=[],puts=[];let revision=0;
 const store={records,etags,gets,puts,onPut:null,
  async get(key){gets.push(key);return records.has(key)?{etag:etags.get(key),json:async()=>structuredClone(records.get(key))}:null;},
  async put(key,value,options={}){
   if(store.onPut)await store.onPut(key,value,options);
   const c=options.onlyIf;if(c?.etagDoesNotMatch==='*'&&records.has(key)||c?.etagMatches&&c.etagMatches!==etags.get(key))return null;
   records.set(key,JSON.parse(value));etags.set(key,String(++revision));puts.push(key);return {etag:etags.get(key)};
  },
  async list({prefix=''}={}){return {objects:[...records.keys()].filter(k=>k.startsWith(prefix)).sort().map(key=>({key})),truncated:false};},
  set(key,value){records.set(key,structuredClone(value));etags.set(key,String(++revision));}
 };
 return store;
}
const context=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,TextDecoder,Uint8Array,crypto:webcrypto,setTimeout,ASSETS:{},
 console:{...console,log:()=>{}},fetch:async()=>new Response('unexpected',{status:599})});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),context);for(const file of ['src/domain/scored-resolution.js','src/domain/resolution-acceptance.js','src/sources.js','src/discovery.js','src/enrichment.js','src/letterboxd-diary.js','src/continuation.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker=').replace('export const DiscoveryContinuation','const DiscoveryContinuation'),context);
const call=code=>vm.runInContext(code,context),worker=context.worker;
const publish=call('publishGenerationWithLedger'),ledgerCounts=call('ledgerCounts'),fnv=call('fnv1a32');
const plain=value=>JSON.parse(JSON.stringify(value));

// Deterministic scans: candidate i airs on day d when its pattern says so; some titles leave and return, a few appear once.
const DAY=86400000,BASE=Date.UTC(2026,9,20,12),titles=i=>['Брат','Сталкер','Солярис','Зеркало','Кин-дза-дза','Ирония судьбы'][i%6]+' '+i;
const airs=(i,d)=>i<20?true:i<60?(d+i)%3!==0:i<90?(i+d)%5===0:i<100?d===i%9:false;
function scan(day,universe=100){
 const out=[];
 for(let i=0;i<universe;i++){
  if(!airs(i,day))continue;
  const start=BASE+day*DAY+(i%12)*3600000,title=titles(i)+' ('+(1960+i%40)+')';
  out.push({key:null,confirmedTmdbId:null,title,rawTitles:[title+(day%2?' х/ф':'')],normalizedTitle:null,year:1960+i%40,duration:90+(i%5)*5+(day%3),description:'Описание '+i+(day%4===0?' (день '+day+')':''),firstAiring:start,lastAiring:start,airings:1,shows:[{channelId:'ch'+(i%7),channel:'Канал '+(i%7),start,end:start+5400000,epgTitle:title}]});
 }
 return out;
}
const runId=day=>'00000000-0000-4000-8000-'+String(day).padStart(12,'0');
async function commit(store,day,mode,{expectThrow=false,latest=scan(day),id=runId(day)}={}){
 const env={BUCKET:store,DISCOVERY_LEDGER_MODE:mode};
 store.set('sync.json',{runId:id,stage:'epg',updatedAt:new Date(BASE+day*DAY).toISOString()});
 const files={'discovered-films.json':{},'programme.json':{runId:id,films:[],updatedAt:new Date(BASE+day*DAY).toISOString()}};
 try{await publish(env,id,latest,{programmeRunId:id,updatedAt:new Date(BASE+day*DAY).toISOString()},files);}
 catch(error){if(expectThrow)return error;throw error;}
 if(expectThrow)assert.fail('commit '+day+' should have stopped');
 return null;
}
const published=store=>store.records.get('epg/published-generation.json')?.programmeRunId||null;
const active=store=>store.records.get('epg/discovery-latest.json');
// The union a pinned reader sees: the published active ledger, its manifest and exactly that manifest's segment versions.
function union(store){
 const ledger=active(store),map=new Map((ledger?.items||[]).map(item=>[item.key,item]));
 const manifestId=ledger?.archive?.manifestId;let archived=0;
 if(manifestId){
  const manifest=store.records.get('epg/discovery-archive/v1/manifests/'+manifestId+'.json');assert.ok(manifest,'the named manifest exists');
  for(const entry of manifest.segments){if(!entry.object)continue;const segment=store.records.get(entry.object);assert.ok(segment,'every named segment version exists');for(const [key,record] of Object.entries(segment.items)){archived++;assert.equal(fnv(key)%manifest.segmentCount,entry.segment,'a key lives in its hash segment');if(!map.has(key))map.set(key,record.payload);}}
 }
 return {map,archived};
}
function assertParity(full,bounded,label){
 const want=new Map(active(full).items.map(item=>[item.key,item])),got=union(bounded).map;
 assert.deepEqual([...got.keys()].sort(),[...want.keys()].sort(),label+': same keys');
 for(const [key,record] of want)assert.deepEqual(plain(got.get(key)),plain(record),label+': payload of '+key);
}
function assertBoundary(store,day,label){
 const ledger=active(store),keys=ledger.items.map(item=>item.key),latest=new Set(scan(day).map(raw=>call('canonicalDiscoveryCandidate')(raw).key));
 assert.equal(new Set(keys).size,keys.length,label+': no duplicate in the active ledger');
 assert.deepEqual([...keys].sort(),[...latest].sort(),label+': active ledger is exactly the latest scan');
}
function assertCounts(store,full,label){
 const counts=ledgerCounts(active(store),{},BASE);
 assert.equal(counts.ledgerTotal,active(full).items.length,label+': ledgerTotal counts unique keys of active ∪ archive');
 assert.equal(counts.ledgerTotal,union(store).map.size,label+': ledgerTotal equals the pinned union');
}

// 1. Multi-day accumulation: three full-mode days (an old full ledger), then bounded. Parity, boundary and counts every day.
const full=makeStore(),bounded=makeStore();
for(let day=0;day<14;day++){
 await commit(full,day,'full');
 await commit(bounded,day,day<3?'full':'bounded');
 assert.equal(published(bounded),runId(day));
 if(day>=3){assertParity(full,bounded,'day '+day);assertBoundary(bounded,day,'day '+day);assertCounts(bounded,full,'day '+day);}
}
assert.ok(active(full).items.length>active(bounded).items.length,'the bounded active ledger is smaller than the full one');
assert.equal(active(bounded).ledgerMode,'bounded');
const firstArchive=active(bounded).archive;assert.ok(firstArchive.manifestId&&firstArchive.items>0);
// Re-entry: a title that left and came back has its merged history, equal to full mode (covered by parity) and is active.
const returning=active(bounded).items.find(item=>/^Сталкер 61|^Кин-дза-дза 64/.test(item.title)||item.rawTitles.length>1);assert.ok(returning,'a returning title is active');
// Write-once: every segment and manifest version was created once and never overwritten; only current.json changes.
for(const key of bounded.puts.filter(key=>key.startsWith('epg/discovery-archive/v1/')&&!key.endsWith('current.json')))assert.equal(bounded.puts.filter(other=>other===key).length,1,'write-once '+key);

// 2. Decisions are untouched by archiving and re-entry.
const decisions={[active(bounded).items[0].key]:{status:'verified',tmdbId:'42'},'gone|1999':{status:'ambiguous',retryAt:'2026-11-01T00:00:00.000Z'}};
bounded.set('epg/discovery-resolution.json',decisions);full.set('epg/discovery-resolution.json',decisions);
await commit(full,14,'full');await commit(bounded,14,'bounded');
assert.deepEqual(bounded.records.get('epg/discovery-resolution.json'),decisions,'the resolution store is not written by archiving');
assertParity(full,bounded,'day 14');

// 3. Status: the pipeline status reports the archive block and unique ledgerTotal without reading any archive segment.
bounded.gets.length=0;
const statusEnv={BUCKET:bounded,DISCOVERY_LEDGER_MODE:'bounded'};
const status=await (await worker.fetch(new Request('https://iptv.vladimino.workers.dev/api/enrichment/pipeline/status'),statusEnv,{waitUntil(){}})).json();
assert.equal(status.ledgerTotal,active(full).items.length);assert.equal(status.archive.ledgerMode,'bounded');assert.equal(status.archive.activeItems,active(bounded).items.length);
assert.equal(bounded.gets.filter(key=>key.startsWith('epg/discovery-archive/')).length,0,'status reads no archive object');

// 4. A discovery chunk reads no archive object either (TMDB is unreachable here, so the chunk errors after its reads).
bounded.gets.length=0;
bounded.set('epg/resolver-continuation.json',{stage:'paused',reason:'epg_committed',at:new Date().toISOString(),hopId:null,remainingChunks:12,nextCatchUpAt:null,retryAt:null,programmeRunId:published(bounded)});
await worker.fetch(new Request('https://iptv.vladimino.workers.dev/api/enrichment/discovery/resolve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({limit:2})}),{...statusEnv,TMDB_API_READ_ACCESS_TOKEN:'t',TMDB_REQUEST_INTERVAL_MS:0},{waitUntil(){}});
assert.ok(bounded.gets.some(key=>key.includes('discovery-latest.json')),'the chunk read the active ledger');
assert.equal(bounded.gets.filter(key=>key.startsWith('epg/discovery-archive/')).length,0,'the chunk reads no archive object');

// 5. Routes that rewrite the whole ledger answer 409 once the ledger is bounded.
for(const route of ['/api/enrichment/discovery/scan','/api/enrichment/discovery/reconcile']){
 const response=await worker.fetch(new Request('https://iptv.vladimino.workers.dev'+route,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}),statusEnv,{waitUntil(){}});
 assert.equal(response.status,409,route);
}

// Kill windows run on copies of the bounded store taken after day 14, against the same full-mode reference.
function cloneStore(source){const copy=makeStore();for(const [key,value] of source.records)copy.set(key,value);return copy;}
const pointerEtag=store=>store.etags.get('epg/discovery-archive/v1/current.json');
let fullNext=cloneStore(full);await commit(fullNext,15,'full');

// 6. Killed after the first new segment version: nothing referenced changes, a retry of the same run completes with parity.
for(const [label,match] of [['first segment',key=>key.includes('/segments/')],['manifest',key=>key.includes('/manifests/')],['archive pointer',key=>key.endsWith('current.json')]]){
 const store=cloneStore(bounded),before=pointerEtag(store);let fired=false;
 store.onPut=async key=>{if(!fired&&match(key)){fired=true;throw new Error('killed at '+label);}};
 await commit(store,15,'bounded',{expectThrow:true});
 assert.equal(published(store),runId(14),label+': nothing published');assert.equal(pointerEtag(store),before,label+': archive pointer unchanged');
 assertParity(full,store,label+' after kill');
 store.onPut=null;await commit(store,15,'bounded');
 assertParity(fullNext,store,label+' retry');assertBoundary(store,15,label+' retry');assertCounts(store,fullNext,label+' retry');
}

// 7. P → R (archive CAS succeeds, publication killed) → S keeps R's departures: counts stay exact, alsoArchived knows them.
{
 // R's scan drops two titles that have aired every day, so their archive copies are R's own, never archived before.
 const store=cloneStore(bounded);let fired=false,neverArchived=['Сталкер 1','Кин-дза-дза 4'];
 assert.ok(neverArchived.every(title=>!active(bounded).archive.alsoArchived.some(key=>key.startsWith(title.toLowerCase()))));
 store.onPut=async key=>{if(!fired&&key==='epg/published-generation.json'){fired=true;throw new Error('killed before publication');}};
 await commit(store,15,'bounded',{expectThrow:true,latest:scan(14).filter(raw=>!neverArchived.some(title=>raw.title.startsWith(title+' ')))});
 assert.equal(published(store),runId(14));assert.notEqual(pointerEtag(store),pointerEtag(bounded),'R swapped the archive pointer');
 store.onPut=null;
 // S is a scan in which R's departures are still on air: day 14's scan again under a new run id.
 const env={BUCKET:store,DISCOVERY_LEDGER_MODE:'bounded'},id=runId(99);store.set('sync.json',{runId:id,stage:'epg'});
 await publish(env,id,scan(14),{programmeRunId:id},{'discovered-films.json':{},'programme.json':{runId:id,films:[]}});
 const ref=cloneStore(full);ref.set('sync.json',{runId:id,stage:'epg'});await publish({BUCKET:ref,DISCOVERY_LEDGER_MODE:'full'},id,scan(14),{programmeRunId:id},{'discovered-films.json':{},'programme.json':{runId:id,films:[]}});
 assertParity(ref,store,'P→R→S');assertCounts(store,ref,'P→R→S');
 // R's manifest is the archive state S started from; every key R archived that S kept active must be in alsoArchived.
 const rManifest=store.records.get('epg/discovery-archive/v1/manifests/'+store.records.get('epg/discovery-archive/v1/current.json').manifestId+'.json');
 const activeKeys=new Set(active(store).items.map(item=>item.key)),keptByS=rManifest.upsertedKeys.filter(key=>activeKeys.has(key));
 assert.ok(keptByS.length===2,'S keeps exactly the two titles R archived');
 for(const key of keptByS)assert.ok(active(store).archive.alsoArchived.includes(key),'alsoArchived lists '+key);
 for(const key of active(store).archive.alsoArchived)assert.ok(activeKeys.has(key));
}

// 8. A chain longer than the bound (nine aborted writers) forces the segment-by-segment recount; counts stay exact.
{
 const store=cloneStore(bounded);
 for(let attempt=0;attempt<9;attempt++){
  let fired=false;store.onPut=async key=>{if(!fired&&key==='epg/published-generation.json'){fired=true;throw new Error('killed');}};
  await commit(store,15+(attempt%2),'bounded',{expectThrow:true});
 }
 store.onPut=null;store.gets.length=0;
 const startManifest=store.records.get('epg/discovery-archive/v1/manifests/'+store.records.get('epg/discovery-archive/v1/current.json').manifestId+'.json');
 const env={BUCKET:store,DISCOVERY_LEDGER_MODE:'bounded'},id=runId(98);store.set('sync.json',{runId:id,stage:'epg'});
 await publish(env,id,scan(14),{programmeRunId:id},{'discovered-films.json':{},'programme.json':{runId:id,films:[]}});
 const ref=cloneStore(full);ref.set('sync.json',{runId:id,stage:'epg'});await publish({BUCKET:ref,DISCOVERY_LEDGER_MODE:'full'},id,scan(14),{programmeRunId:id},{'discovered-films.json':{},'programme.json':{runId:id,films:[]}});
 assertParity(ref,store,'long chain');assertCounts(store,ref,'long chain');
 const segmentReads=new Set(store.gets.filter(key=>key.includes('/segments/'))),named=startManifest.segments.filter(entry=>entry.object).map(entry=>entry.object);
 for(const object of named)assert.ok(segmentReads.has(object),'the recount read every segment version of the starting manifest');
}

// 9. Fences: a stale commit (another publication meanwhile), a lost lease, a changed sync run and a lost archive pointer race
//    all stop before anything is published and leave the archive pointer where it was.
for(const [label,interfere] of [
 ['stale commit',store=>store.set('epg/published-generation.json',{programmeRunId:'ffffffff-0000-4000-8000-000000000000',phase:'published'})],
 ['lost lease',store=>store.set('epg/resolver-lease.json',{id:'other',expiresAt:Date.now()+60000})],
 ['sync run changed',store=>store.set('sync.json',{runId:'someone-else',stage:'epg'})],
 ['archive pointer race',store=>store.set('epg/discovery-archive/v1/current.json',{manifestId:'raced'})],
]){
 const store=cloneStore(bounded),before=pointerEtag(store),beforePublished=store.records.get('epg/published-generation.json');let fired=false;
 store.onPut=async key=>{if(!fired&&(label==='archive pointer race'?key.includes('/manifests/'):key.includes('/segments/'))){fired=true;interfere(store);}};
 const error=await commit(store,15,'bounded',{expectThrow:true});
 assert.match(String(error.message),/fence lost|changed/,label);
 if(label!=='archive pointer race')assert.equal(pointerEtag(store),before,label+': archive pointer unchanged');
 if(label!=='stale commit')assert.deepEqual(store.records.get('epg/published-generation.json'),beforePublished,label+': nothing published');
}

// 9b. Another publication between the archive CAS and this commit's pointer switch: the commit must not overwrite it.
{
 const store=cloneStore(bounded),other={programmeRunId:'eeeeeeee-0000-4000-8000-000000000000',phase:'published'};let fired=false;
 store.onPut=async key=>{if(!fired&&key==='epg/generations/'+runId(15)+'/discovery-latest.json'){fired=true;store.set('epg/published-generation.json',other);}};
 const error=await commit(store,15,'bounded',{expectThrow:true});
 assert.match(String(error.message),/changed during publish/);
 assert.deepEqual(store.records.get('epg/published-generation.json'),other,'the other publication stands');
}

// 10. Frozen: no new archive version, departures stay active (as in full mode), the archive stays history; `full` with an
//     archive acts as frozen and never rebuilds.
for(const mode of ['frozen','full']){
 const store=cloneStore(bounded),archiveBefore=store.records.get('epg/discovery-archive/v1/current.json');
 await commit(store,15,mode);
 assert.deepEqual(store.records.get('epg/discovery-archive/v1/current.json'),archiveBefore,mode+': no archive write');
 assert.equal(active(store).ledgerMode,'frozen',mode+': acts as frozen');
 assertParity(fullNext,store,mode);assertCounts(store,fullNext,mode);
}

// 11. Without an archive, `frozen` and the default `full` write the unchanged single ledger (no ledgerMode marker).
{
 const store=makeStore(),ref=makeStore();await commit(store,0,'frozen');await commit(store,1,'full');await commit(ref,0,'full');await commit(ref,1,'full');
 assert.equal(active(store).ledgerMode,undefined);assert.equal(store.records.has('epg/discovery-archive/v1/current.json'),false);
 assert.deepEqual(plain(active(store)),plain(active(ref)),'frozen without an archive writes exactly the full-mode ledger');
}

console.log('Discovery ledger archive (ADR 0034): multi-day parity, exact boundary, unique counts, write-once versions, decisions untouched, status and chunk read boundary, gated routes, kill windows with retry, P→R→S, long-chain recount, fences, frozen and full-with-archive passed');
