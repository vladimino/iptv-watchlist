// AIR-261 / ADR 0034: the offline importer reads a bounded discovery ledger as the published active ledger plus exactly the
// archive manifest it names and that manifest's segment versions (rule D: active wins). The same daily scans run through the
// Worker's own commit in `full` and in `bounded` mode; both snapshots are imported through the CLI and must produce the same
// candidate, generation, show and decision rows. Missing, corrupt, duplicate, off-chain and miscounted archive objects stop the
// import before the database is touched; versions the published ledger does not name are classified, not read.
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
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),context);for(const file of ['src/domain/scored-resolution.js','src/domain/resolution-acceptance.js','src/sources.js','src/discovery.js','src/enrichment.js','src/continuation.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker=').replace('export const DiscoveryContinuation','const DiscoveryContinuation'),context);
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
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {manifestFor} from '../scripts/migration-export.mjs';
import {classifyObject,readDiscoveryArchive} from '../src/offline-importer.js';
import {loadDomainRules} from '../scripts/offline-import.mjs';

const rules=loadDomainRules();
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-archive-import-'));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const at='2026-10-28T00:00:00.000Z';

// The two Worker stores: identical scans, one in full mode, one bounded from day 0 (a bounded Worker reads a full ledger).
const full=makeStore(),bounded=makeStore();
for(let day=0;day<12;day++){await commit(full,day,'full');await commit(bounded,day,'bounded');}
// Crash window 3 of the ADR: the archive pointer moves, publication is killed. The pointer is then ahead of the published
// ledger and the archive holds copies of keys that are still active; the next commit of the same scans keeps them in alsoArchived.
let fired=false;
bounded.onPut=async key=>{if(!fired&&key==='epg/published-generation.json'){fired=true;throw new Error('killed before publication');}};
await commit(bounded,12,'bounded',{expectThrow:true});
bounded.onPut=null;
await commit(full,12,'full');await commit(bounded,12,'bounded');
// One more killed writer leaves the pointer ahead of what the snapshot's published ledger names.
fired=false;
bounded.onPut=async key=>{if(!fired&&key==='epg/published-generation.json'){fired=true;throw new Error('killed before publication');}};
await commit(bounded,13,'bounded',{expectThrow:true});
bounded.onPut=null;
const ledger=active(bounded);
assert.equal(ledger.ledgerMode,'bounded');
assert.ok(ledger.archive.alsoArchived.length>0,'the scenario leaves active keys with an archive copy');
const pointerAhead=bounded.records.get('epg/discovery-archive/v1/current.json').manifestId;
assert.notEqual(pointerAhead,ledger.archive.manifestId,'the archive pointer is ahead of the published ledger');
assert.ok(active(full).items.length>ledger.items.length,'history sits in the archive');

// Decisions on an active key, an archived key and a key in both; one decision without any candidate stays class C.
const fullItems=active(full).items,activeKeys=new Set(ledger.items.map(item=>item.key));
const archivedOnly=fullItems.find(item=>!activeKeys.has(item.key)),both=ledger.archive.alsoArchived[0],live=ledger.items.find(item=>!ledger.archive.alsoArchived.includes(item.key));
const decision=(item,status,extra={})=>({status,checkedAt:at,evidenceKey:rules.candidateEvidence(item),...extra});
const byKey=key=>fullItems.find(item=>item.key===key);
const resolution={[archivedOnly.key]:decision(archivedOnly,'excluded_nonfilm',{reason:'nonfilm'}),[both]:decision(byKey(both),'ambiguous',{reason:'ambiguous'}),[live.key]:decision(live,'retry',{reason:'not_found',attempts:1}),'gone|1999':{status:'ambiguous',checkedAt:at}};

const lifecycle={'watchlist.json':{films:[]},'epg/discovery-resolution.json':resolution};
function snapshotOf(store,overrides={}){
 const bodies={};
 for(const [key,value] of store.records)bodies[key]=value;
 Object.assign(bodies,lifecycle,overrides);
 for(const [key,value] of Object.entries(bodies))if(value===undefined)delete bodies[key];
 return bodies;
}
function writeSnapshot(name,bodies){
 const directory=path.join(tmp,name);
 fs.rmSync(directory,{recursive:true,force:true});fs.mkdirSync(path.join(directory,'objects'),{recursive:true});
 const entries=Object.entries(bodies).map(([key,value])=>{
  const bytes=Buffer.isBuffer(value)?value:Buffer.from(typeof value==='string'?value:JSON.stringify(value),'utf8');
  const file='objects/'+sha(Buffer.from(key,'utf8'))+'.bin';
  fs.writeFileSync(path.join(directory,file),bytes);
  return {key,file,size:bytes.length,sha256:sha(bytes),metadata:{size:bytes.length}};
 });
 fs.writeFileSync(path.join(directory,'manifest.json'),JSON.stringify(manifestFor(entries,1,at,at,[])));
 return directory;
}
function runImport(directory,database,status=0){
 const result=spawnSync(process.execPath,['scripts/offline-import.mjs','--snapshot',directory,'--database',database],{encoding:'utf8',maxBuffer:64*1024*1024});
 assert.equal(result.status,status,result.stderr||result.stdout.slice(0,2000));
 return JSON.parse(result.stdout);
}
function rows(database,sql){const result=spawnSync('sqlite3',['-json',database,sql],{encoding:'utf8',maxBuffer:64*1024*1024});assert.equal(result.status,0,result.stderr);return result.stdout.trim()?JSON.parse(result.stdout):[];}

// Every key either store writes is classified: nothing new is unknown.
for(const key of bounded.records.keys())assert.notEqual(classifyObject(key),'unmapped',key);
assert.equal(classifyObject('epg/discovery-archive/v1/current.json'),'mapped');
assert.equal(classifyObject('epg/discovery-archive/v1/sources/m/discovery-latest.json'),'r2_only');
assert.equal(classifyObject('epg/discovery-archive/v2/current.json'),'unmapped','another archive version fails closed');
assert.equal(classifyObject('epg/discovery-archive/v1/segments/7/x.json'),'unmapped','a segment outside the three-digit layout fails closed');

// 1. Full-ledger semantics: the bounded snapshot imports the same discovery rows as the full one.
const fullDb=path.join(tmp,'full.sqlite'),boundedDb=path.join(tmp,'bounded.sqlite');
const fullRun=runImport(writeSnapshot('full',snapshotOf(full)),fullDb);
const boundedRun=runImport(writeSnapshot('bounded',snapshotOf(bounded)),boundedDb);
for(const run of [fullRun,boundedRun]){assert.equal(run.stopped,false,JSON.stringify(run.blockers));assert.equal(run.parity.ok,true,JSON.stringify({missing:run.parity.missing.slice(0,5),extra:run.parity.extra.slice(0,5),mismatched:run.parity.mismatched.slice(0,5)}));assert.deepEqual(run.parity.unprojected,[]);}
assert.equal(fullRun.discoveryArchive.mode,'full');
const summary=boundedRun.discoveryArchive;
assert.equal(summary.mode,'bounded');
assert.equal(summary.manifestId,ledger.archive.manifestId);
assert.equal(summary.ledgerTotal,fullItems.length,'unique keys of active ∪ archive equal the full ledger');
assert.equal(summary.active,ledger.items.length);
assert.equal(summary.alsoArchived,ledger.archive.alsoArchived.length);
assert.equal(summary.uniqueArchived,ledger.archive.uniqueArchivedItems);
assert.ok(summary.unreferenced.manifests>=2&&summary.unreferenced.segments>0,'older and ahead-of-publication versions are classified, not read');
for(const sql of [
 'SELECT programme_run_id,observation_key,evidence_key,observation_json FROM candidate_generation ORDER BY programme_run_id,observation_key',
 'SELECT observation_key,title,normalized_title,year,raw_titles_json,durations_json,description,evidence_key,activity,seen_in_latest,last_seen_programme_run_id FROM candidate ORDER BY observation_key',
 'SELECT programme_run_id,observation_key,channel_id,start_ms,end_ms,epg_title FROM candidate_show ORDER BY 1,2,3,4,5,6',
 'SELECT observation_key,status,reason,evidence_key,checked_at,attempts,terminal_reason,provenance_json FROM candidate_decision ORDER BY observation_key',
])assert.deepEqual(rows(boundedDb,sql),rows(fullDb,sql),sql);
assert.equal(rows(boundedDb,'SELECT COUNT(*) AS n FROM candidate_generation')[0].n,fullItems.length);
assert.equal(rows(boundedDb,`SELECT status FROM candidate_decision WHERE observation_key='${archivedOnly.key.replaceAll("'","''")}'`)[0].status,'excluded_nonfilm','a decision on an archived key attaches to its archived candidate');
assert.equal(boundedRun.ledger.find(item=>item.targetId==='gone|1999')?.reason,'decision_without_candidate');
const records=boundedRun.parity.records.filter(record=>record.key.startsWith('epg/discovery-archive/'));
assert.ok(records.some(record=>record.disposition==='mapped'&&record.key.includes('/segments/')));
assert.ok(records.some(record=>record.disposition==='unreferenced'&&record.key.includes('/manifests/')));
assert.deepEqual([...new Set(records.map(record=>record.disposition))].sort(),['mapped','unreferenced']);
assert.ok(boundedRun.classes.B.unreferencedVersions.some(key=>key.startsWith('epg/discovery-archive/')));
if(process.env.ARCHIVE_IMPORT_REPORT)console.log(JSON.stringify({full:fullRun.discoveryArchive,bounded:summary,candidates:fullItems.length,decisions:rows(boundedDb,'SELECT COUNT(*) AS n FROM candidate_decision')[0].n,shows:rows(boundedDb,'SELECT COUNT(*) AS n FROM candidate_show')[0].n,archiveRecords:records.reduce((out,record)=>(out[record.disposition]=(out[record.disposition]||0)+1,out),{}),denominator:boundedRun.parity.denominator}));
// A rerun writes nothing new.
const again=runImport(writeSnapshot('bounded',snapshotOf(bounded)),boundedDb);
assert.equal(again.applied,0);assert.equal(again.parity.ok,true);

// 2. Fail closed: each case stops with exit 3 and the stated reason, and creates no database.
const manifestKey=id=>'epg/discovery-archive/v1/manifests/'+id+'.json';
const named=bounded.records.get(manifestKey(ledger.archive.manifestId));
const segmentEntries=named.segments.filter(entry=>entry.object);
const [first,second]=segmentEntries;
const firstBody=bounded.records.get(first.object),secondBody=bounded.records.get(second.object);
const movedKey=Object.keys(firstBody.items)[0];
const rewritten=(entry,body)=>{const text=JSON.stringify(body);return {[entry.object]:text,[manifestKey(ledger.archive.manifestId)]:{...named,segments:named.segments.map(item=>item.segment===entry.segment?{...item,sha256:sha(Buffer.from(text,'utf8')),items:Object.keys(body.items).length}:item),totals:{...named.totals,items:named.totals.items+Object.keys(body.items).length-entry.items}}};};
const bothCopies=value=>({'epg/discovery-latest.json':value,['epg/generations/'+published(bounded)+'/discovery-latest.json']:value});
const cases=[
 ['archive_segment_missing',{[first.object]:undefined}],
 ['archive_segment_sha256_mismatch',{[first.object]:JSON.stringify({...firstBody,writeId:'tampered'})}],
 ['archive_manifest_missing',{[manifestKey(ledger.archive.manifestId)]:undefined}],
 ['archive_duplicate_key',rewritten(second,{...secondBody,items:{...secondBody.items,[movedKey]:firstBody.items[movedKey]}})],
 ['archive_segment_invalid',rewritten(first,{...firstBody,items:{...firstBody.items,[movedKey]:{...firstBody.items[movedKey],payload:{...firstBody.items[movedKey].payload,key:'other|1900'}}}})],
 ['archive_pointer_conflict',{'epg/discovery-archive/v1/current.json':{manifestId:'00000000-0000-4000-8000-00000000dead'},[manifestKey('00000000-0000-4000-8000-00000000dead')]:{...named,manifestId:'00000000-0000-4000-8000-00000000dead',parentManifestId:null}}],
 ['archive_pointer_missing',{'epg/discovery-archive/v1/current.json':undefined}],
 ['archive_counts_mismatch',bothCopies({...ledger,archive:{...ledger.archive,uniqueArchivedItems:ledger.archive.uniqueArchivedItems+1}})],
 ['archive_counts_mismatch',bothCopies({...ledger,archive:{...ledger.archive,alsoArchived:ledger.archive.alsoArchived.slice(1)}})],
 ['archive_manifest_unnamed',bothCopies({...ledger,archive:{...ledger.archive,manifestId:null}})],
 ['discovery_ledger_copies_differ',{'epg/discovery-latest.json':{...ledger,updatedAt:'2026-10-28T00:00:01.000Z'}}],
 ['unknown_key',{'epg/discovery-archive/v2/current.json':{manifestId:'x'}}],
];
for(const [reason,overrides] of cases){
 const database=path.join(tmp,'refused-'+reason+'.sqlite');
 const result=runImport(writeSnapshot('refused',snapshotOf(bounded,overrides)),database,3);
 assert.equal(result.stopped,true,reason);
 assert.ok(result.stopReasons.includes(reason),reason+': '+JSON.stringify(result.stopReasons));
 assert.equal(fs.existsSync(database),false,reason+': no database is created');
}

// 3. The reader on its own: the shared segment rule is required, and a full ledger next to archive objects is read as full.
await assert.rejects(()=>readDiscoveryArchive({ledger,keys:[],read:async()=>null}),/ledgerArchiveSegment/);
const fullRead=await readDiscoveryArchive({ledger:active(full),keys:[...bounded.records.keys()],read:async()=>null,segmentOf:rules.ledgerArchiveSegment});
assert.equal(fullRead.mode,'full');assert.equal(fullRead.blockers.length,0);assert.equal(fullRead.ledger.items.length,fullItems.length);

fs.rmSync(tmp,{recursive:true,force:true});
console.log('Discovery archive import (ADR 0034): full-ledger parity of candidates, generations, shows and decisions through the CLI, pointer ahead of publication and leftover copies, unreferenced versions classified, rerun idempotent, fail-closed on missing, corrupt, duplicate, invalid, off-chain and miscounted archive objects, differing ledger copies and unknown archive keys passed');
