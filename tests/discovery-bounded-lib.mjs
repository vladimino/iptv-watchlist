// AIR-426 / AIR-429: shared harness of the bounded-ledger tests. The real planner (`planDiscoveryLedger` through `stageSealedGeneration`) and the
// real ledger seal run against a sqlite stand-in of D1 and an in-memory bucket; helpers build generations, take leases, read the R2 union of an
// active ledger and its archive, and assert payload parity with one ever-growing ledger in R2 and in D1. No Cloudflare, TMDB or production.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import * as Authority from '../src/discovery-authority.js';
import {loadWorker} from '../scripts/discovery-ledger-offline.mjs';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';

export const context=loadWorker();
context.DiscoveryAuthority=Authority;
export const call=code=>vm.runInContext(code,context);
const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-bounded-d1-'));
const chain=['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state','0005_film_sync_state','0006_metadata_cache','0007_prediction_authority','0008_published_epg_authority','0009_owner_review_authority','0010_ratings_authority','0011_discovery_authority','0012_discovery_seal'];
let n=0;
export const sql=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:text+';',encoding:'utf8',maxBuffer:1<<28});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
export const migrate=()=>{const file=path.join(root,'b-'+(n++)+'.sqlite');const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+chain.map(x=>fs.readFileSync('migrations/'+x+'.sql','utf8')).join('\n'),encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);sql(file,"UPDATE discovery_authority SET mode='d1', cutover='open' WHERE id=1");return file;};
export const plain=value=>JSON.parse(JSON.stringify(value));

// What the planner and the seal need of R2: string and stream puts, conditional puts (create-only and etag match), ranged gets
// with a chunked body, head with a size, delete. `onPut` lets a test fail or observe a write.
export function bucket(chunk=4096){
 const objects=new Map();let revision=0;
 const read=async value=>{if(typeof value==='string')return Buffer.from(value,'utf8');if(value&&typeof value.getReader==='function'){const reader=value.getReader(),parts=[];for(;;){const step=await reader.read();if(step.done)break;parts.push(Buffer.from(step.value));}return Buffer.concat(parts);}return Buffer.from(value);};
 const store={objects,puts:[],onPut:null,bytesWritten:0,
  async put(key,value,options={}){
   const bytes=await read(value);
   if(store.onPut)await store.onPut(key,options);
   const c=options.onlyIf,current=objects.get(key);
   if(c?.etagDoesNotMatch==='*'&&current||c?.etagMatches&&c.etagMatches!==current?.etag)return null;
   objects.set(key,{bytes,etag:'e'+(++revision)});store.puts.push(key);store.bytesWritten+=bytes.length;
   return {etag:objects.get(key).etag};
  },
  async head(key){const o=objects.get(key);return o?{etag:o.etag,size:o.bytes.length}:null;},
  async delete(key){objects.delete(key);},
  async list({prefix='',limit=1000}={}){return {objects:[...objects.keys()].filter(key=>key.startsWith(prefix)).sort().slice(0,limit).map(key=>({key}))};},
  async get(key,options={}){
   const o=objects.get(key);if(!o)return null;
   const offset=options.range?.offset??0,bytes=o.bytes.subarray(offset);
   return {etag:o.etag,text:async()=>bytes.toString('utf8'),json:async()=>JSON.parse(bytes.toString('utf8')),body:new ReadableStream({start(controller){for(let at=0;at<bytes.length;at+=chunk)controller.enqueue(new Uint8Array(bytes.subarray(at,at+chunk)));controller.close();}})};
  },
  json(key){const o=objects.get(key);return o?JSON.parse(o.bytes.toString('utf8')):null;},
 };
 return store;
}

// Deterministic scans (the pattern of tests/discovery-ledger-archive.mjs): some titles always air, some leave and return,
// some appear once.
export const DAY=86400000,BASE=Date.UTC(2026,9,20,12),titles=i=>['Брат','Сталкер','Солярис','Зеркало','Кин-дза-дза','Ирония судьбы'][i%6]+' '+i;
export const airs=(i,d)=>i<20?true:i<60?(d+i)%3!==0:i<90?(i+d)%5===0:i<100?d===i%9:false;
export function scan(day,universe=100){
 const out=[];
 for(let i=0;i<universe;i++){
  if(!airs(i,day))continue;
  const start=BASE+day*DAY+(i%12)*3600000,title=titles(i)+' ('+(1960+i%40)+')';
  out.push({key:null,confirmedTmdbId:null,title,rawTitles:[title+(day%2?' х/ф':'')],normalizedTitle:null,year:1960+i%40,duration:90+(i%5)*5+(day%3),description:'Описание '+i+(day%4===0?' (день '+day+')':''),firstAiring:start,lastAiring:start,airings:1,shows:[{channelId:'ch'+(i%7),channel:'Канал '+(i%7),start,end:start+5400000,epgTitle:title}]});
 }
 return out;
}
export const runId=day=>'00000000-0000-4000-8000-'+String(day).padStart(12,'0');
export const merge=call('mergeDiscoveryCandidates'),keyOf=call('discoveryCandidateKey');
export const POINTER='epg/discovery-archive/v1/current.json';

export function world(){
 const file=migrate(),bkt=bucket();
 const state={file,bkt,published:null,full:[],generation:0};
 context.PublishedEpg={
  async readAuthority(){return {cutover:'open',mode:'d1'};},
  async currentGeneration(){return state.published?{programmeRunId:state.published.programmeRunId,phase:'published',fence:state.published.fence}:null;},
 };
 return state;
}
export const envOf=(state,mode)=>({DB:d1Standin(state.file,{maxBinds:100}),BUCKET:state.bkt,discoveryLease:null,...(mode?{DISCOVERY_LEDGER_MODE:mode}:{})});
export async function takeLease(env,file){sql(file,'UPDATE discovery_lease SET expires_at=1 WHERE id=1');const lease=await call('acquireDiscoveryLease')(env);assert.ok(lease,'a lease');return lease;}

// The first generation is installed the way a cutover leaves it: one full ledger in the R2 generation copy and the same rows in D1.
export async function bootstrap(state,day,latest=scan(day)){
 const id=runId(day);
 state.full=merge([],latest,{replaceShows:true,programmeRunId:id});
 const framing=call('discoveryDocumentFraming')({programmeRunId:id},{}),encoder=new TextEncoder(),encoded=state.full.map(item=>encoder.encode(JSON.stringify(item)));
 await state.bkt.put('epg/generations/'+id+'/discovery-latest.json',call('discoveryDocumentStream')(framing,(async function*(){for(const bytes of encoded)yield bytes;})()));
 const env=envOf(state);
 const taken=await Authority.acquireLease(env,{programmeRunId:null});env.discoveryLease=taken.lease;
 await Authority.ingestLedger(env,{programmeRunId:id,handoff:true,lease:taken.lease,items:(async function*(){for(const item of state.full)yield item;})()});
 await Authority.releaseLease(env,taken.lease);
 state.published={programmeRunId:id,fence:'g'+(++state.generation)};
}
// One EPG commit and its ledger seal, by the Worker's own functions. `mode` is the flag (undefined: unset).
export async function commit(state,day,mode,{latest=scan(day),sealSteps=Infinity,expectThrow=false}={}){
 const id=runId(day),at=new Date(BASE+day*DAY).toISOString();
 const env=(state.envFactory||envOf)(state,mode);
 await state.bkt.put('sync.json',JSON.stringify({runId:id,stage:'epg',startedAt:at,updatedAt:at}));
 const run={runId:id,stage:'epg',startedAt:at,watchlist:[],events:[]};
 // The lease of the previous step is left to expire, as between two requests.
 sql(state.file,'UPDATE discovery_lease SET expires_at=1 WHERE id=1');
 const before=state.bkt.bytesWritten,puts=state.bkt.puts.length,started=Date.now();
 try{
  await context.stageSealedGeneration(env,run,{holder:{discovery:latest},meta:{programmeRunId:id,updatedAt:at},pending:{'programme.json':{runId:id,updatedAt:at},'discovered-films.json':{}},nextWatchlist:{updatedAt:at,films:[]},uncertain:[],publication:{programmeRunId:state.published.programmeRunId,phase:'published',fence:state.published.fence}});
 }catch(error){if(expectThrow)return {error,run};throw error;}
 if(expectThrow)assert.fail('commit of day '+day+' should have stopped');
 const staging={ms:Date.now()-started,r2Bytes:state.bkt.bytesWritten-before,r2Puts:state.bkt.puts.length-puts};
 assert.equal(run.stage,'seal');
 let steps=0,done=false;const calls=env.DB.calls,trips=()=>calls.queries+calls.batches,from=trips();
 while(!done&&steps<sealSteps){
  steps++;
  const stepEnv=(state.envFactory||envOf)(state,mode),lease=await takeLease(stepEnv,state.file);
  const result=await call('sealLedgerStep')(stepEnv,run,lease,Date.now()+60000);
  done=result.done;staging.sealTrips=(staging.sealTrips||0)+stepEnv.DB.calls.queries+stepEnv.DB.calls.batches;staging.sealBatches=(staging.sealBatches||0)+stepEnv.DB.calls.batches;
 }
 void from;
 if(!done)return {run,staging,done:false};
 // The ledger is committed; the pointer would move in the publish step. The model of one ever-growing ledger moves with it.
 state.published={programmeRunId:id,fence:'g'+(++state.generation)};
 state.full=merge(state.full,latest,{replaceShows:true,programmeRunId:id});
 return {run,staging,done:true};
}

// The union a reader pinned to the published generation sees in R2: its active ledger plus exactly the manifest it names.
export function r2Union(state){
 const id=state.published.programmeRunId,doc=state.bkt.json('epg/generations/'+id+'/discovery-latest.json');
 assert.equal(doc.programmeRunId,id);
 const map=new Map(doc.items.map(item=>[item.key,item]));
 let archived=0,segmentsRead=0;
 const manifestId=doc.archive?.manifestId||null;
 if(manifestId){
  const manifest=state.bkt.json('epg/discovery-archive/v1/manifests/'+manifestId+'.json');assert.ok(manifest,'the named manifest exists');
  for(const entry of manifest.segments){
   if(!entry.object)continue;
   const segment=state.bkt.json(entry.object);assert.ok(segment,'the named segment version exists');segmentsRead++;
   for(const [key,record] of Object.entries(segment.items)){archived++;if(!map.has(key))map.set(key,record.payload);}
  }
  assert.equal(archived,manifest.totals.items,'the manifest counts its items');
  assert.equal(doc.archive.uniqueArchivedItems,manifest.totals.items-doc.archive.alsoArchived.length);
 }
 return {doc,map,manifestId,archived,segmentsRead};
}
// Payload parity with one ever-growing ledger, in R2 and in D1.
export function assertParity(state,label){
 const {doc,map}=r2Union(state),full=new Map(state.full.map(item=>[item.key,item]));
 assert.deepEqual([...map.keys()].sort(),[...full.keys()].sort(),label+': active plus archive hold every key ever seen, and no other');
 for(const [key,item] of full)assert.deepEqual(plain(map.get(key)),plain(item),label+': payload parity for '+key);
 // D1: the active rows are the document's items, nothing is left retiring, nothing was deleted.
 const rows=sql(state.file,"SELECT observation_key AS k, payload_json AS p, residence AS r, programme_run_id AS run FROM discovery_observation WHERE source_key='active' ORDER BY observation_key");
 assert.equal(rows.length,doc.items.length,label+': D1 active rows equal the active ledger');
 assert.ok(rows.every(row=>row.r==='active'&&row.run===state.published.programmeRunId),label+': every active row is of this run');
 const byKey=new Map(doc.items.map(item=>[item.key,item]));
 for(const row of rows){const {shows,...rest}=byKey.get(row.k);assert.equal(row.p,JSON.stringify(rest),label+': D1 payload of '+row.k);void shows;}
 const showRows=Number(sql(state.file,"SELECT COUNT(*) AS n FROM discovery_observation_show WHERE source_key='active'")[0].n);
 assert.equal(showRows,doc.items.reduce((total,item)=>total+(item.shows||[]).length,0),label+': D1 show rows of the active ledger');
 assert.equal(sql(state.file,'SELECT state FROM discovery_transfer')[0].state,'committed');
 assert.ok(['idle','done'].includes(sql(state.file,'SELECT phase FROM discovery_seal')[0].phase),label+': no seal job is open');
 return {doc,active:doc.items.length,total:full.size};
}
export const d1Counts=file=>Object.fromEntries(sql(file,"SELECT residence AS r, COUNT(*) AS n FROM discovery_observation GROUP BY residence").map(row=>[row.r,Number(row.n)]));
