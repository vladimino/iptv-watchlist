// AIR-427. Under D1 authority the pipeline status reports the ledger mode and the archive of the published generation only as far as that
// generation's own R2 document proves them: never a literal `bounded`, never D1's row count as the size of the archive. A real seal on the
// SQLite stand-in, the Worker's own document framing, a byte-accurate bucket. Nothing here calls Cloudflare or production.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import * as Authority from '../src/discovery-authority.js';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';

assert.doesNotMatch(fs.readFileSync('src/discovery-authority.js','utf8'),/ledgerMode:[^,;]*'bounded'/,'no hard-coded bounded in the D1 reader');

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-status-ledger-mode-'));
const chain=['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state','0005_film_sync_state','0006_metadata_cache','0007_prediction_authority','0008_published_epg_authority','0009_owner_review_authority','0010_ratings_authority','0011_discovery_authority','0012_discovery_seal'];
let databases=0;
const migrated=(names=chain)=>{const file=path.join(root,'s-'+(databases++)+'.sqlite');const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+names.map(x=>fs.readFileSync('migrations/'+x+'.sql','utf8')).join('\n'),encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);return file;};

// R2 as the status uses it: byte ranges, the object's full size and etag on a ranged get, and a record of every read and write.
function bucket(){
 const objects=new Map(),log={reads:[],writes:[]};let revision=0,fail=null;
 const bytesOf=async value=>{if(typeof value==='string')return Buffer.from(value,'utf8');if(value&&typeof value.getReader==='function'){const reader=value.getReader(),parts=[];for(;;){const step=await reader.read();if(step.done)break;parts.push(Buffer.from(step.value));}return Buffer.concat(parts);}return Buffer.from(value);};
 return {
  objects,log,failOn(fn){fail=fn;},
  async put(key,value){log.writes.push('put '+key);objects.set(key,{bytes:await bytesOf(value),etag:'e'+(++revision)});return {etag:objects.get(key).etag};},
  async delete(key){log.writes.push('delete '+key);objects.delete(key);},
  async head(key){const o=objects.get(key);return o?{etag:o.etag,size:o.bytes.length}:null;},
  async list(){return {objects:[],truncated:false};},
  async get(key,options={}){
   const o=objects.get(key);if(!o)return null;
   if(fail&&fail(key,options))throw new Error('R2 read failed');
   const offset=options.range?.offset??0,length=options.range?.length??(o.bytes.length-offset),part=o.bytes.subarray(offset,offset+length);
   log.reads.push({key,offset,bytes:part.length,ranged:!!options.range});
   return {etag:o.etag,size:o.bytes.length,text:async()=>part.toString('utf8'),json:async()=>JSON.parse(part.toString('utf8')),body:new ReadableStream({start(c){c.enqueue(new Uint8Array(part));c.close();}})};
  },
 };
}
const item=(n,title)=>({key:'k'+String(n).padStart(5,'0'),title,normalizedTitle:title.toLowerCase(),year:2001,durations:[100],shows:[{channelId:'c',channel:'Канал',start:1793000000000+n,end:1793000100000+n}],seenInLatestSnapshot:true,lastAiring:1793000000000});
const TITLES=['Брат','Сталкер','Кавычки "цитата"','Скобка ],"ledgerMode":"bounded","archive":null}','Descripción — ñ','日本語'];
const ITEMS=Array.from({length:300},(_,n)=>item(n,TITLES[n%TITLES.length]+' '+n));
const ORIGIN='https://iptv.vladimino.workers.dev';

// One published generation: the document the commit writes (the Worker's own framing) and a seal run to its end, as the EPG publication does.
async function generation({runId='run-new',ledger,seal=true,names=chain}={}){
 const file=migrated(names),bkt=bucket();
 const queries=[];
 const db=d1Standin(file,{onQuery:text=>{queries.push(text);}});
 db.sql("UPDATE discovery_authority SET mode='d1', cutover='open' WHERE id=1");
 const env={DB:db,BUCKET:bkt,discoveryLease:null,TMDB_API_READ_ACCESS_TOKEN:'test'};
 const live=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,TextDecoder,ReadableStream,Uint8Array,crypto:webcrypto,console:{log(){},error(){},warn(){}},setTimeout,structuredClone,fetch:async()=>{throw new Error('status makes no request');},DiscoveryAuthority:Authority});
 for(const name of ['src/domain/scored-resolution.js','src/domain/resolution-acceptance.js','src/sources.js','src/discovery.js','src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/worker.js'])vm.runInContext(fs.readFileSync(name,'utf8').replace('export default','globalThis.worker='),live);
 const call=code=>vm.runInContext(code,live);
 const key='epg/generations/'+runId+'/discovery-latest.json';
 const framing=call('discoveryDocumentFraming')({programmeRunId:runId,updatedAt:'2026-11-10T17:00:00.000Z'},ledger);
 const encoder=new TextEncoder(),encoded=ITEMS.map(i=>encoder.encode(JSON.stringify(i)));
 await bkt.put(key,call('discoveryDocumentStream')(framing,(async function*(){for(const bytes of encoded)yield bytes;})()));
 const stored=await bkt.head(key);
 const taken=await Authority.acquireLease(env,{programmeRunId:null});env.discoveryLease=taken.lease;
 if(seal){
  await Authority.sealBegin(env,{programmeRunId:runId,jobId:'job-'+runId,sourceKey:key,sourceEtag:stored.etag,itemTotal:ITEMS.length,startBytes:framing.prefix.byteLength,lease:taken.lease});
  let cursor=0,rest=ITEMS.map((value,n)=>({item:value,bytes:encoded[n].byteLength+1}));
  while(rest.length){const done=await Authority.sealWrite(env,{jobId:'job-'+runId,expectedCursor:cursor,items:rest,lease:taken.lease});cursor=done.cursorItems;rest=rest.slice(done.written);}
  for(;;){const done=await Authority.sealArchive(env,{jobId:'job-'+runId,lease:taken.lease,limit:500});if(done.committed)break;}
 }else{
  await Authority.ingestLedger(env,{programmeRunId:runId,handoff:true,lease:taken.lease,items:(async function*(){for(const value of ITEMS)yield value;})()});
 }
 await Authority.releaseLease(env,taken.lease);env.discoveryLease=null;
 await bkt.put('epg/published-generation.json',JSON.stringify({phase:'published',programmeRunId:runId}));
 await bkt.put('programme.json',JSON.stringify({runId,films:[]}));
 await bkt.put('epg/discovery-resolution.json',JSON.stringify({}));
 await bkt.put('epg/discovered-films.json',JSON.stringify({}));
 const status=async()=>{
  bkt.log.reads.length=0;bkt.log.writes.length=0;queries.length=0;const batches=db.calls.batches;
  const response=await live.worker.fetch(new Request(ORIGIN+'/api/enrichment/pipeline/status'),env,{waitUntil(){}});
  const body=await response.json();
  return {status:response.status,body,reads:[...bkt.log.reads],writes:[...bkt.log.writes],sqlWrites:queries.filter(text=>/^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i.test(text)),batches:db.calls.batches-batches};
 };
 return {file,db,bkt,env,key,status,live};
}
// A status GET is a read: nothing is written to R2 or D1, and the generation document is read only in two short ranges.
function assertPure(result,key,{ranges}){
 assert.deepEqual(result.writes,[],'no R2 write');
 assert.deepEqual(result.sqlWrites,[],'no D1 write statement');
 assert.equal(result.batches,0,'no D1 batch');
 const onDocument=result.reads.filter(read=>read.key===key);
 assert.equal(onDocument.length,ranges,'reads of the generation document');
 for(const read of onDocument){assert.ok(read.ranged);assert.ok(read.bytes<=512,'a bounded read, not a scan: '+read.bytes);}
}
const ARCHIVE={version:'v1',manifestId:'manifest-33525',segments:64,items:33525,bytes:18243111,alsoArchived:Array.from({length:15177},(_,n)=>'also-'+String(n).padStart(6,'0')),uniqueArchivedItems:18348};

// 1. The production state of 10 November 2026: a `frozen` generation with an R2 archive of 33,525 items, 18,348 of them archive-only, and
//    no archive row in D1. The status used to say `bounded` and an archive of 0.
{
 const {status,key}=await generation({ledger:{ledgerMode:'frozen',archive:ARCHIVE}});
 const result=await status();
 assert.equal(result.status,200);
 const p=result.body;
 assert.deepEqual(p.archive,{ledgerMode:'frozen',ledgerModeSource:'generation_document',activeItems:300,activeSource:'d1',uniqueArchivedItems:18348,manifestId:'manifest-33525',segments:64,items:33525,bytes:18243111,archiveSource:'r2_generation_document',d1:{archiveOnlyRows:0,unreferencedRows:0,segmentRows:0}});
 assert.equal(p.ledgerTotal,300+18348);assert.equal(p.candidates,300+18348);assert.equal(p.ledgerTotalScope,'active_and_archive');
 assert.equal(p.programmeRunId,'run-new');
 assertPure(result,key,{ranges:2});
 // The same body on a second read: the status is a function of what is stored.
 assert.deepEqual((await status()).body.archive,p.archive);
}

// 2. A generation written `bounded` says so, from the same proof; an empty `alsoArchived` and a title that imitates the header change nothing.
{
 const {status,key}=await generation({ledger:{ledgerMode:'bounded',archive:{...ARCHIVE,alsoArchived:[],items:120,uniqueArchivedItems:120}}});
 const result=await status();
 assert.equal(result.body.archive.ledgerMode,'bounded');assert.equal(result.body.archive.ledgerModeSource,'generation_document');
 assert.equal(result.body.archive.uniqueArchivedItems,120);assert.equal(result.body.ledgerTotal,420);
 assertPure(result,key,{ranges:2});
}

// 2b. AIR-429: a bounded generation that still holds backlog says so. Its active ledger is the scan plus that backlog, and the status
//     does not call it the scan: `drain` carries what is left and the cap. Without backlog the field is absent, as before.
{
 const draining=await generation({ledger:{ledgerMode:'bounded',drain:{backlog:21673,cap:8000},archive:{...ARCHIVE,alsoArchived:[],items:44839,uniqueArchivedItems:44839}}});
 const result=await draining.status();
 assert.equal(result.body.archive.ledgerMode,'bounded');
 assert.deepEqual(result.body.archive.drain,{backlog:21673,cap:8000});
 assert.equal(result.body.archive.uniqueArchivedItems,44839);assert.equal(result.body.archive.ledgerModeSource,'generation_document');
 assertPure(result,draining.key,{ranges:2});
 // no archive at all but backlog (a first commit that archived nothing yet)
 const bare=await generation({ledger:{ledgerMode:'bounded',drain:{backlog:5,cap:3},archive:null}});
 const bareResult=await bare.status();
 assert.equal(bareResult.body.archive.ledgerMode,'bounded');assert.deepEqual(bareResult.body.archive.drain,{backlog:5,cap:3});
 assertPure(bareResult,bare.key,{ranges:1});
 // a drained or ordinary bounded generation has no drain field
 const done=await generation({ledger:{ledgerMode:'bounded',archive:{...ARCHIVE,alsoArchived:[],items:120,uniqueArchivedItems:120}}});
 assert.equal('drain' in (await done.status()).body.archive,false);
 // a drain that no commit can write (on a frozen ledger, or with nothing left) is not believed: unknown, not a guess
 for(const ledger of [{ledgerMode:'frozen',drain:{backlog:3,cap:2},archive:null},{ledgerMode:'bounded',drain:{backlog:0,cap:2},archive:null}]){
  const bad=await generation({ledger});
  const body=(await bad.status()).body;
  assert.equal(body.archive.ledgerMode,'unknown');assert.equal(body.archive.ledgerModeReason,'generation_document_unreadable');
 }
}

// 3. A `full` ledger has no header at all (the document ends at `]}`), and `frozen` without an archive names none: both are proven, with
//    an archive of zero that is a fact and is labelled `none`.
for(const [ledger,mode] of [[{},'full'],[{ledgerMode:'frozen',archive:null},'frozen']]){
 const {status,key}=await generation({ledger});
 const result=await status();
 assert.deepEqual(result.body.archive,{ledgerMode:mode,ledgerModeSource:'generation_document',activeItems:300,activeSource:'d1',uniqueArchivedItems:0,manifestId:null,segments:0,items:0,bytes:0,archiveSource:'none',d1:{archiveOnlyRows:0,unreferencedRows:0,segmentRows:0}});
 assert.equal(result.body.ledgerTotal,300);assert.equal(result.body.ledgerTotalScope,'active_and_archive');
 assertPure(result,key,{ranges:1});
}

// 4. Whatever is not proven is `unknown` with its reason, with null figures (never 0) and the total limited to the active ledger.
const unknown=(body,reason,d1={archiveOnlyRows:0,unreferencedRows:0,segmentRows:0})=>{
 assert.deepEqual(body.archive,{ledgerMode:'unknown',ledgerModeSource:'unavailable',ledgerModeReason:reason,activeItems:300,activeSource:'d1',uniqueArchivedItems:null,manifestId:null,segments:null,items:null,bytes:null,archiveSource:'unavailable',d1},reason);
 assert.equal(body.ledgerTotal,300);assert.equal(body.candidates,300);assert.equal(body.ledgerTotalScope,'active_only');
};
{
 // the feature flag is not evidence: with it set to bounded and no proof, the answer is still unknown
 const g=await generation({ledger:{ledgerMode:'frozen',archive:ARCHIVE},seal:false});
 g.env.DISCOVERY_LEDGER_MODE='bounded';
 unknown((await g.status()).body,'seal_record_unavailable');
 // no seal table at all (a schema before the resumable seal)
 const old=await generation({ledger:{ledgerMode:'frozen',archive:ARCHIVE},seal:false,names:chain.slice(0,-1)});
 unknown((await old.status()).body,'seal_record_unavailable');
}
{
 const g=await generation({ledger:{ledgerMode:'frozen',archive:ARCHIVE}});
 // the seal record names another generation than the one published in D1 (a stale or mismatched generation)
 g.db.sql("UPDATE discovery_seal SET programme_run_id='run-older' WHERE id=1");
 unknown((await g.status()).body,'seal_of_another_generation');
 g.db.sql("UPDATE discovery_seal SET programme_run_id='run-new', phase='archive' WHERE id=1");
 unknown((await g.status()).body,'seal_not_complete');
 g.db.sql("UPDATE discovery_seal SET phase='done', cursor_items=cursor_items-1 WHERE id=1");
 unknown((await g.status()).body,'seal_not_complete');
 g.db.sql("UPDATE discovery_seal SET cursor_items=item_total WHERE id=1");
 assert.equal((await g.status()).body.archive.ledgerMode,'frozen','restored');
 // the document was replaced after the seal (another etag), or is gone
 const bytes=g.bkt.objects.get(g.key).bytes;
 await g.bkt.put(g.key,bytes.toString('utf8'));
 unknown((await g.status()).body,'generation_document_changed');
 await g.bkt.delete(g.key);
 unknown((await g.status()).body,'generation_document_missing');
}
{
 // an offset that does not land on the end of the items, a header of another shape, a damaged end, an impossible figure
 const g=await generation({ledger:{ledgerMode:'frozen',archive:ARCHIVE}});
 const row=g.db.sql('SELECT cursor_bytes AS n FROM discovery_seal')[0].n;
 g.db.sql('UPDATE discovery_seal SET cursor_bytes='+(row-7)+' WHERE id=1');
 unknown((await g.status()).body,'generation_document_unreadable');
 g.db.sql('UPDATE discovery_seal SET cursor_bytes='+row+' WHERE id=1');
 const rewrite=async change=>{const text=change(g.bkt.objects.get(g.key).bytes.toString('utf8'));await g.bkt.put(g.key,text);g.db.sql("UPDATE discovery_seal SET source_etag='"+(await g.bkt.head(g.key)).etag+"' WHERE id=1");};
 const original=g.bkt.objects.get(g.key).bytes.toString('utf8');
 await rewrite(text=>text.replace('"ledgerMode":"frozen"','"ledgerMode":"sideways"'));
 unknown((await g.status()).body,'generation_document_unreadable');
 await rewrite(()=>original.replace('"uniqueArchivedItems":18348}}','"uniqueArchivedItems":"many"}}'));
 unknown((await g.status()).body,'generation_document_unreadable');
 await rewrite(()=>original.replace('"uniqueArchivedItems":18348}}','"uniqueArchivedItems":99999}}'));
 unknown((await g.status()).body,'generation_document_unreadable');
 await rewrite(()=>original);
 assert.equal((await g.status()).body.archive.uniqueArchivedItems,18348);
 // a read error on either range fails closed to unknown; the rest of the status is still served
 g.bkt.failOn((key,options)=>key===g.key&&!!options.range);
 const failed=await g.status();
 assert.equal(failed.status,200);unknown(failed.body,'read_failed');
 g.bkt.failOn(null);
}

// 5. D1 archive rows are D1 rows: reported under `d1`, never added to the total and never shown as the archive when the archive is unknown.
{
 const g=await generation({ledger:{ledgerMode:'frozen',archive:ARCHIVE}});
 g.db.sql("INSERT INTO discovery_observation (source_key, observation_key, residence, programme_run_id, normalized_title, title, year, evidence_key, seen_in_latest, last_seen_at, last_airing, confirmed_tmdb_id, payload_json) VALUES ('archive:old','gone-1','archive','run-new','a','A',1990,'',0,1,NULL,NULL,'{}'),('archive:old','gone-2','archive','run-new','b','B',1990,'',0,1,NULL,NULL,'{}')");
 const proven=(await g.status()).body;
 assert.deepEqual(proven.archive.d1,{archiveOnlyRows:2,unreferencedRows:0,segmentRows:0});
 assert.equal(proven.archive.uniqueArchivedItems,18348);assert.equal(proven.ledgerTotal,300+18348,'the D1 rows are not added to the proven archive');
 await g.bkt.delete(g.key);
 unknown((await g.status()).body,'generation_document_missing',{archiveOnlyRows:2,unreferencedRows:0,segmentRows:0});
}

// 6. A loading transfer still fails closed, and a held cutover does not read the D1 ledger: both as before.
{
 const g=await generation({ledger:{ledgerMode:'frozen',archive:ARCHIVE}});
 g.db.sql("UPDATE discovery_transfer SET state='loading' WHERE id=1");
 const loading=await g.status();
 assert.equal(loading.status,502);assert.equal(loading.body.error,'discovery_incomplete');assert.deepEqual(loading.writes,[]);assert.deepEqual(loading.sqlWrites,[]);
}

console.log('epg status ledger mode tests passed');
