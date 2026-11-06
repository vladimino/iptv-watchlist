// AIR-359: the same contract on the sealed D1 publication path. The first scan of a run is interrupted before the staging
// completes (no pointer move, no event), a retry rescans, stages, seals in bounded steps and publishes; the EPG event then
// describes that published report once, and a removal event keeps the key its hand-over references. Local sqlite stand-ins only.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import * as Authority from '../src/discovery-authority.js';
import {loadWorker} from '../scripts/discovery-ledger-offline.mjs';
import {d1Standin} from './d1-standin.mjs';

const context=loadWorker();
context.DiscoveryAuthority=Authority;
const call=code=>vm.runInContext(code,context);
const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-event-d1-'));
const chain=['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state','0005_film_sync_state','0006_metadata_cache','0007_prediction_authority','0008_published_epg_authority','0009_owner_review_authority','0010_ratings_authority','0011_discovery_authority','0012_discovery_seal'];
const sql=(file,text)=>{const r=spawnSync('sqlite3',['-json','-bail',file],{input:text+';',encoding:'utf8',maxBuffer:1<<28});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
let n=0;
const migrate=()=>{const file=path.join(root,'e-'+(n++)+'.sqlite');const r=spawnSync('sqlite3',['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+chain.map(x=>fs.readFileSync('migrations/'+x+'.sql','utf8')).join('\n'),encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);sql(file,"UPDATE discovery_authority SET mode='d1', cutover='open' WHERE id=1");return file;};

function bucket(){
 const objects=new Map();let revision=0;
 const read=async value=>{if(typeof value==='string')return Buffer.from(value,'utf8');if(value&&typeof value.getReader==='function'){const reader=value.getReader(),parts=[];for(;;){const step=await reader.read();if(step.done)break;parts.push(Buffer.from(step.value));}return Buffer.concat(parts);}return Buffer.from(value);};
 return {
  objects,
  async put(key,value,options={}){const c=options.onlyIf;if(c?.etagDoesNotMatch==='*'&&objects.has(key)||c?.etagMatches&&objects.get(key)?.etag!==c.etagMatches)return null;const bytes=await read(value);objects.set(key,{bytes,etag:'e'+(++revision)});return {etag:objects.get(key).etag};},
  async head(key){const o=objects.get(key);return o?{etag:o.etag,size:o.bytes.length}:null;},
  async delete(key){objects.delete(key);},
  async list({prefix=''}={}){return {objects:[...objects.keys()].filter(k=>k.startsWith(prefix)).sort().map(key=>({key})),truncated:false};},
  async get(key,options={}){const o=objects.get(key);if(!o)return null;const offset=options.range?.offset??0,bytes=o.bytes.subarray(offset);return {etag:o.etag,text:async()=>bytes.toString('utf8'),json:async()=>JSON.parse(bytes.toString('utf8')),body:new ReadableStream({start(controller){controller.enqueue(new Uint8Array(bytes));controller.close();}})};},
 };
}
const item=(key,start)=>({key,title:'T '+key,normalizedTitle:'t '+key,year:2001,durations:[100],shows:[{channelId:'c',channel:'C',start,end:start+1000}],seenInLatestSnapshot:true,lastAiring:start});
const keys=(a,b)=>Array.from({length:b-a},(_,i)=>'k'+String(a+i).padStart(5,'0'));
const NEW=keys(20,120).map(key=>item(key,Date.now()+3600000));
const xmltv=t=>new Date(t).toISOString().replace(/[-:T]/g,'').slice(0,14)+' +0000';
let showCount=1;
const epgXml=()=>{const start=Date.now()+10*3600000;const shows=Array.from({length:showCount},(_,i)=>`<programme channel="c1" start="${xmltv(start+i*6*3600000)}" stop="${xmltv(start+i*6*3600000+170*60000)}"><title>Heat (1995)</title></programme>`).join('');return `<tv><channel id="c1"><display-name>Кино</display-name></channel>${shows}</tv>`;};
context.fetch=async url=>{if(String(url)==='https://epg.test/guide.xml')return new Response(epgXml());throw new Error('no network: '+url);};

const file=migrate();
// The previous generation's committed ledger.
{
 const env={DB:d1Standin(file),BUCKET:bucket(),discoveryLease:null};
 const taken=await Authority.acquireLease(env,{programmeRunId:null});env.discoveryLease=taken.lease;
 await Authority.ingestLedger(env,{programmeRunId:'run-old',handoff:true,lease:taken.lease,items:(async function*(){for(const k of keys(0,40))yield item(k,Date.now()+3600000);})()});
 await Authority.releaseLease(env,taken.lease);
}
const bkt=bucket();
const published=[];
context.PublishedEpg={
 async readAuthority(){return {cutover:'open',mode:'d1'};},
 async currentGeneration(){return {programmeRunId:'run-old',phase:'published',fence:'g1'};},
 async publishGeneration(env,input){published.push(input);return {ok:true,programmeRunId:input.programmeRunId};},
 async writeMirrors(){return true;},
 async saveWatchlist(){return true;},
 async repairMirrors(){return null;},
 async readDocumentAt(env,run,kind){
  if(kind==='watchlist'){const object=await bkt.get('watchlist.json');return object?object.json():null;}
  return {runId:'run-old',updatedAt:'2026-11-05T00:00:00.000Z',films:[],stats:{epgEnd:Date.now()+86400000}};
 },
};
context.copyEpgGeneration=async()=>{};
context.queueCommittedDiscovery=async()=>{};
context.refreshPredictionQueue=async()=>{};
context.planDiscoveryLedger=async()=>({items:NEW,ledger:{ledgerMode:'bounded'},holder:null});
// The real finishSync writes the events; the ratings tail is not part of this contract.
context.completeWithRatings=async(env,run,report)=>call('finishSync')(env,run,report);
const stepEnv=()=>({DB:d1Standin(file),BUCKET:bkt,discoveryLease:null,EPG_XML_URL:'https://epg.test/guide.xml',LETTERBOXD_USERNAME:'fixture'});
const events=()=>[...bkt.objects.keys()].filter(key=>key.startsWith('events/items/')).sort().map(key=>({key,...JSON.parse(bkt.objects.get(key).bytes.toString('utf8'))}));
const put=async(key,value)=>bkt.put(key,JSON.stringify(value));
const pause=()=>new Promise(resolve=>setTimeout(resolve,15));

const film={id:'film1',title:'Heat',original:'Heat',year:1995,runtime:170,tmdbId:'165',aliases:['Heat'],url:'https://letterboxd.com/film/heat-1995/'};
// The watchlist published before this run holds a film that this run's list no longer has: a removal to hand over.
await put('watchlist.json',{updatedAt:'2026-01-01T00:00:00.000Z',films:[film,{id:'gone',title:'Gone',original:'Gone',year:1999,tmdbId:'4242',url:'https://letterboxd.com/film/gone/'}]});
await put('titles.json',{});await put('people.json',{});
const run={runId:'run-new',stage:'epg',startedAt:'2026-11-06T10:00:00.000Z',pages:1,pending:[],watchlist:[film]};

// 1. First scan; the staging is interrupted before anything is published.
const realStage=context.stageSealedGeneration;
context.stageSealedGeneration=async()=>{throw new Error('interrupted before staging');};
showCount=1;
await assert.rejects(()=>call('epgSync')(stepEnv(),run),/interrupted before staging/);
assert.equal(published.length,0,'nothing is published');
assert.equal(events().length,0,'an attempt that never published writes no event');
const first=run.events.find(event=>event.type==='epg');assert.ok(first,'the first scan left its events on the run');
const firstWatch=run.events.find(event=>event.type==='watchlist');
assert.deepEqual(firstWatch.removed.map(f=>f.id),['gone']);
const refKey=JSON.parse(JSON.stringify(run.removalRefs));

// 2. The retry rescans (later time, more shows), stages for real, seals in bounded steps and publishes.
context.stageSealedGeneration=realStage;
await pause();showCount=3;
const staged=await call('epgSync')(stepEnv(),run);
assert.equal(staged.stage,'seal');
assert.equal(events().length,0,'staging writes no event');
let result,steps=0;
do{steps++;const env=stepEnv();sql(file,'UPDATE discovery_lease SET expires_at=1 WHERE id=1');result=await call('sealStep')(env,run);}while(result.stage!=='complete'&&steps<40);
assert.equal(result.stage,'complete');assert.equal(published.length,1,'one publication');
const report=published[0].pending?.['programme.json']??published[0].programme??null;
assert.ok(report,'the publication carries the report: '+Object.keys(published[0]).join(','));
const epg=events().filter(event=>event.type==='epg');
assert.equal(epg.length,1,'exactly one EPG event');
assert.equal(epg[0].id,'run-new-epg');assert.equal(epg[0].at,report.updatedAt,'its time is the published report time');assert.notEqual(epg[0].at,first.at);
assert.equal(epg[0].broadcasts,report.films.reduce((count,f)=>count+f.shows.length,0));assert.equal(epg[0].broadcasts,3);

// 3. The removal event: one, same delta, and the hand-over reference names the key that was written.
const watch=events().filter(event=>event.type==='watchlist');
assert.equal(watch.length,1);assert.deepEqual(watch[0].removed.map(f=>f.id),['gone']);assert.equal(watch[0].added.length,0);
const key='events/items/'+String(9999999999999-Date.parse(watch[0].at)).padStart(13,'0')+'-'+watch[0].id+'.json';
assert.equal(watch[0].key,key);
const refs=JSON.parse(JSON.stringify(run.removalRefs??refKey));const list=Array.isArray(refs)?refs:[refs];
assert.ok(list.every(item=>item.ref.eventKey===key),'every removal reference names the written event');
assert.deepEqual(JSON.parse(JSON.stringify(refKey)),JSON.parse(JSON.stringify(run.removalRefs??refKey)),'the references did not change across the retry');

// 4. Repeats add nothing: another finishSync of the same report and a reread of the journal.
await call('finishSync')(stepEnv(),run,report);
assert.equal(events().filter(event=>event.type==='epg').length,1);assert.equal(events().filter(event=>event.type==='watchlist').length,1);
console.log('AIR-359 D1 sealed path: interrupted staging writes no event, the retry publishes once, one EPG event for the published report, stable removal references and idempotence passed');
