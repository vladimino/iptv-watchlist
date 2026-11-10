// AIR-373 stage B (ADR 0099, Accepted; owner decision of 10 Nov 2026, option A): the NARROW projector-input snapshot adapter.
// OFFLINE and INACTIVE: not bundled (build.mjs lists no such file), no Worker import, no route, cron or job, no side effect at import or deploy.
// It reads only the keys the enrichment projector itself reads (ALLOWLIST below), never lists or scans a bucket, and sends only GET and HEAD of allowlisted keys
// through the read-only client of scripts/r2-snapshot-export.mjs (R2_SNAPSHOT_*, bucket-scoped; R2_INSTALL_* is never used here).
// The expected side is built by the projector's own code: enrichmentStore / enrichmentInputs (src/enrichment-projection.js), the LifecycleReader view
// (the same vm loader scripts/d1-projection-seed.mjs uses) and OwnerReview.applyViewOverlay. The D1-derived inputs are read by the projector's own readers
// (PublishedEpg, DiscoveryAuthority, OwnerReview) through a guard that lets only one read-only SELECT through. The comparison is the stage A ledger.
//
// HONEST LIMITS (they are repeated in docs/runbooks/film-person-baseline.md):
// - Equal R2 ETags before and after do NOT prove a consistent snapshot ACROSS R2 and D1. They prove that each object did not change between two HEADs. The cut
//   is R2 ETag stability + the D1 gate rows and the content witness before and after + the projector lease of the stage A stable cut during the D1 read.
// - The cut does not cover writers that bypass the projector lease, and inputs that move between the R2 reads and the D1 reads (a D1-owned input can change
//   after its read and before the D1 cut): the witness is a fingerprint, not a proof. Any difference found is a refusal, never a pass.
// - A report from this module is a MEASUREMENT. Its source is never `verified`, so baselineGate always refuses it: it cannot record a baseline.
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {CLASSES,DEFAULT_EXPLANATIONS,LEDGER_VERSION,LIST_CAP,buildParityLedger,contextFromActual,expectedFromInputs,keyOf,readStableCut,readWitness,readerOf} from '../src/film-person-baseline.js';
import {enrichmentInputs,enrichmentStore,filmChangeKey,personChangeKey,watchlistAdmissionsFromIndex,archiveAdmissionsFromDocument} from '../src/enrichment-projection.js';
import {applyViewOverlay,stampLocalized} from '../src/owner-review-d1.js';
import * as PublishedEpg from '../src/published-epg.js';
import * as DiscoveryAuthority from '../src/discovery-authority.js';
import * as OwnerReview from '../src/owner-review-d1.js';
import {lifecycleReader} from './d1-projection-seed.mjs';
import {personOverridesFromSource} from './snapshot-store.mjs';
import {assertReadOnly,unwrap} from './schema-preflight.mjs';
import {createReadOnlyClient} from './r2-snapshot-export.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const MANIFEST_VERSION=1;
export const REPORT_VERSION=1;
export const SCHEMA_EXPECTED=18;
// Per object. The largest projector input is metadata.json; the cap is a refusal threshold, not a measurement (unmeasured: the real sizes).
export const MAX_OBJECT_BYTES=64*1024*1024;
export const MAX_TOTAL_BYTES=512*1024*1024;
const RUN_ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const stable=value=>JSON.stringify(value,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const shortHash=value=>sha(String(value)).slice(0,12);

// ---------- the allowlist: ONE constant, derived from d1EnrichmentStore (src/d1-enrichment.js) ----------
// gate: the D1 authority that can reroute the key (the projector then reads D1, never R2, and so does the capture):
//   publishedEpg  published_epg_authority mode d1 + cutover open   -> pointer, watchlist.json and programme come from D1 (PublishedEpg.authoritativeSnapshot)
//   discovery     discovery_authority mode d1 + cutover open       -> catalog and decisions come from D1 (DiscoveryAuthority.routeRead); a held cutover = unknown
//   ownerReview   owner_review_authority mode d1                   -> the owner document comes from D1 (OwnerReview.readFenced); the R2 mirror is not read
// missing/malformed: what the projector does (D1EnrichmentInputError reason) and what the capture does (always fail closed, stable reason `missing:<id>` /
// `malformed:<id>`; the projector treats a malformed FENCE object as absent, the capture refuses it: stricter, never looser).
// shape: record = non-array object; filmList = record with a `films` array; archive = record, schemaVersion 1, `films` record; owner = contractVersion 1 with
// `films` and `people` records; pointer = record with phase 'published' and a programmeRunId.
export const ALLOWLIST=Object.freeze([
 {id:'discoveryLease',key:'epg/resolver-lease.json',role:'fence',required:false,gate:null,shape:'record',projector:'d1EnrichmentWritersIdle: live expiresAt => writer_active'},
 {id:'sync',key:'sync.json',role:'fence',required:false,gate:null,shape:'record',projector:'d1EnrichmentWritersIdle: stage metadata|epg within 15 min => writer_active'},
 {id:'publishedPointer',key:'epg/published-generation.json',role:'pointer',required:true,gate:'publishedEpg',shape:'pointer',projector:'EPG_GENERATION_KEY: input_missing / generation_unpublished'},
 {id:'watchlist',key:'watchlist.json',role:'input',required:true,gate:'publishedEpg',shape:'filmList',projector:'input_missing / input_invalid'},
 {id:'programme',template:'epg/generations/{runId}/programme.json',role:'input',required:true,gate:'publishedEpg',shape:'filmList',projector:'epgGenerationKey(runId,programme.json)'},
 {id:'metadata',key:'metadata.json',role:'input',required:true,gate:null,shape:'record',projector:'input_missing / input_invalid'},
 {id:'titles',key:'titles.json',role:'input',required:true,gate:null,shape:'record',projector:'input_missing / input_invalid'},
 {id:'people',key:'people.json',role:'input',required:true,gate:null,shape:'record',projector:'input_missing / input_invalid'},
 {id:'catalog',template:'epg/generations/{runId}/discovered-films.json',role:'input',required:true,gate:'discovery',shape:'record',projector:'d1EnrichmentDiscoveryRead: generation_pending / input_invalid'},
 {id:'resolution',key:'epg/discovery-resolution.json',role:'input',required:true,gate:'discovery',shape:'record',projector:'d1EnrichmentDiscoveryRead: input_missing / input_invalid'},
 {id:'diary',key:'letterboxd/diary/history.json',role:'input',required:false,gate:null,shape:'record',projector:'optional'},
 {id:'retirements',key:'identity/tmdb-retirements.json',role:'input',required:false,gate:null,shape:'record',projector:'TMDB_RETIREMENTS_KEY optional; present but invalid => input_invalid'},
 {id:'viewIndex',key:'enrichment/view-index.json',role:'input',required:false,gate:null,shape:'record',projector:'optional; absent admits nobody'},
 {id:'verifiedFilms',key:'letterboxd/admissions/verified-films.json',role:'input',required:false,gate:null,shape:'archive',projector:'optional; absent admits nobody'},
 {id:'ownerMirror',key:'admin/owner-reviews.json',role:'input',required:false,gate:'ownerReview',shape:'owner',projector:'only while owner authority mode is r2; optional'},
]);
// The inputs that exist only in D1 (or whose R2 copy is not the source) and how each is read: by the projector's own reader, through the read-only guard.
export const D1_DERIVED=Object.freeze([
 {id:'publishedEpg',gate:'publishedEpg',reader:'PublishedEpg.authoritativeSnapshot',statements:['schema_contract version','published_epg_authority row','published_epg_document pages (SELECT ordinal, payload_json ... ORDER BY ordinal)','published_epg_authority row again']},
 {id:'discoveryCatalog',gate:'discovery',reader:'DiscoveryAuthority.routeRead(epg/generations/<run>/discovered-films.json)',statements:['discovery_authority row','discovery_transfer row','SELECT ... FROM discovery_admission WHERE state=current','discovery_authority row again']},
 {id:'discoveryResolution',gate:'discovery',reader:'DiscoveryAuthority.routeRead(epg/discovery-resolution.json)',statements:['discovery_authority row','SELECT ... FROM discovery_decision (paged)','discovery_authority row again']},
 {id:'ownerReviews',gate:'ownerReview',reader:'OwnerReview.readFenced',statements:['owner_review_authority row','SELECT ... FROM owner_review_entry','owner_review_authority row again']},
 {id:'metadataCache',gate:null,reader:'none',statements:[],note:'film_metadata is a D1 cache the projector WRITES from metadata.json; it is compared by the stage A witness, never read as an input'},
 {id:'tmdbRetirements',gate:null,reader:'identity/tmdb-retirements.json (R2) only',statements:[],note:'tmdb_retirement_current (migration 0016) is the ACTUAL side of the retirement class, empty until the producer integration'},
]);
const EXACT=new Set(ALLOWLIST.filter(item=>item.key).map(item=>item.key));
const TEMPLATES=ALLOWLIST.filter(item=>item.template);
export const allowlistDigest=()=>sha(stable(ALLOWLIST));
export function resolveKey(entry,runId){
 if(entry.key)return entry.key;
 if(typeof runId!=='string'||!RUN_ID.test(runId))throw capError('run_id_invalid');
 return entry.template.replace('{runId}',runId);
}
export function isAllowed(key,runId=null){
 if(typeof key!=='string')return false;
 if(EXACT.has(key))return true;
 return RUN_ID.test(String(runId||''))&&TEMPLATES.some(item=>item.template.replace('{runId}',runId)===key);
}
export class CaptureError extends Error{constructor(reason,detail){super(reason+(detail?': '+detail:''));this.name='CaptureError';this.reason=reason;}}
const capError=(reason,detail)=>new CaptureError(reason,detail);

// ---------- the guards: nothing but an allowlisted GET/HEAD and one read-only SELECT ever leaves this module ----------
// A client for ONE cut: head/get refuse a key outside the allowlist (and a templated key of another run) before any request is built.
export function limitedClient(client,runIdOf){
 const check=key=>{if(!isAllowed(key,runIdOf()))throw capError('key_not_allowlisted');};
 return {head:async(key,options)=>{check(key);return client.head(key,options);},get:async(key,options)=>{check(key);return client.get(key,options);}};
}
export const GATE_STATEMENTS=Object.freeze({
 schema:'SELECT id, version FROM schema_contract ORDER BY id',
 marker:'SELECT id, mode, cutover, generation FROM film_person_authority',
 fence:'SELECT id, ok FROM film_person_cas',
 baseline:'SELECT id, state, reference FROM film_person_baseline',
 lease:"SELECT lease_id, lease_until, started_at FROM projection_run WHERE projection = 'enrichment'",
 window:'SELECT state, owner, requested_at, expires_at FROM projector_window WHERE id = 1',
 discovery:'SELECT mode, cutover, programme_run_id, generation, published_programme_run_id FROM discovery_authority WHERE id = 1',
 discoveryLease:'SELECT lease_id, expires_at FROM discovery_lease WHERE id = 1',
 published:'SELECT mode, cutover, programme_run_id, generation FROM published_epg_authority WHERE id = 1',
 owner:'SELECT mode, generation, writes FROM owner_review_authority WHERE id = 1',
});
for(const sql of Object.values(GATE_STATEMENTS))assertReadOnly(sql);
// A D1 binding that can only read. prepare() refuses any statement that is not one SELECT; batch and run do not exist.
export function readOnlyBinding(binding,log=null){
 return {prepare(sql){
  let text;
  try{text=assertReadOnly(sql);}catch{throw capError('d1_statement_refused');}
  const statement=params=>({first:async()=>{log?.push(text);return binding.prepare(text).bind(...params).first();},all:async()=>{log?.push(text);return binding.prepare(text).bind(...params).all();}});
  return {bind:(...params)=>statement(params),...statement([])};
 }};
}
// A binding over an executor that returns the raw D1 HTTP envelope [{success,results}]: a failed envelope, a missing results array or a non-array result is a
// failed probe (never an empty one); `unwrap` is the schema preflight's.
export function envelopeBinding(execute){
 const run=async(sql,params)=>{const rows=unwrap(await execute(sql,params));if(rows===null)throw capError('probe_failed');return rows;};
 return {prepare(sql){const statement=params=>({first:async()=>(await run(sql,params))[0]??null,all:async()=>({results:await run(sql,params)})});return {bind:(...params)=>statement(params),...statement([])};}};
}
const noTable=error=>/no such (table|column)/i.test(String(error?.message||error));
async function probe(binding,id){
 let rows;
 try{rows=(await binding.prepare(GATE_STATEMENTS[id]).all()).results;}
 catch(error){throw capError(noTable(error)?'gate_unreadable':'probe_failed',id);}
 if(!Array.isArray(rows))throw capError('probe_malformed',id);
 return rows;
}
const one=(rows,id,columns)=>{
 if(rows.length!==1||!rows[0]||typeof rows[0]!=='object')throw capError('probe_malformed',id);
 for(const column of columns)if(!Object.prototype.hasOwnProperty.call(rows[0],column))throw capError('probe_malformed',id);
 return rows[0];
};
const int=(value,id)=>{const number=Number(value);if(value===null||value===undefined||!Number.isFinite(number))throw capError('probe_malformed',id);return number;};
// The D1 side of the cut, read-only: schema, marker, fence, baseline, projector lease, window, discovery generation (+ its lease) and the published and owner
// authority rows. Normalised so two reads compare with stable(); the lease and window carry a live flag, never a timestamp.
export async function readCaptureGate(binding,{now=()=>new Date().toISOString()}={}){
 const at=now(),atMs=Date.parse(at);
 const rows={};
 for(const id of Object.keys(GATE_STATEMENTS))rows[id]=await probe(binding,id);
 const schema=one(rows.schema,'schema',['version']),marker=one(rows.marker,'marker',['mode','cutover','generation']),fence=one(rows.fence,'fence',['ok']),baseline=one(rows.baseline,'baseline',['state']);
 const window=one(rows.window,'window',['state','owner','expires_at']),discovery=one(rows.discovery,'discovery',['mode','cutover','generation']),published=one(rows.published,'published',['mode','cutover','generation']),owner=one(rows.owner,'owner',['mode','generation','writes']);
 if(rows.lease.length>1)throw capError('probe_malformed','lease');
 const lease=rows.lease[0]??null,dlease=rows.discoveryLease.length?one(rows.discoveryLease,'discoveryLease',['lease_id','expires_at']):null;
 return {
  schema:{version:int(schema.version,'schema')},
  marker:{mode:marker.mode,cutover:marker.cutover,generation:int(marker.generation,'marker')},
  fence:{ok:int(fence.ok,'fence')},
  baseline:{state:baseline.state,reference:baseline.reference??null},
  lease:{held:!!(lease?.lease_id&&(typeof lease.lease_until!=='string'||lease.lease_until>at))},
  window:{state:window.state,live:window.state!=='idle'&&int(window.expires_at,'window')>atMs},
  discovery:{mode:discovery.mode,cutover:discovery.cutover,generation:int(discovery.generation,'discovery'),programmeRunId:discovery.programme_run_id??null,publishedProgrammeRunId:discovery.published_programme_run_id??null},
  discoveryLease:{live:!!(dlease?.lease_id&&int(dlease.expires_at,'discoveryLease')>atMs)},
  published:{mode:published.mode,cutover:published.cutover,generation:int(published.generation,'published'),programmeRunId:published.programme_run_id??null},
  owner:{mode:owner.mode,generation:int(owner.generation,'owner'),writes:owner.writes},
 };
}
// Refusals that depend on one gate read. `expected` is the schema version this procedure was written for.
export function gateRefusals(gate,{expectedSchema=SCHEMA_EXPECTED}={}){
 const reasons=[];
 if(gate.schema.version!==expectedSchema)reasons.push('schema_unexpected:'+gate.schema.version);
 if(!['r2','prepared'].includes(gate.marker.mode)||gate.marker.cutover!=='open')reasons.push('marker_not_capturable:'+gate.marker.mode+'/'+gate.marker.cutover);
 if(gate.fence.ok!==1)reasons.push('fence_not_ok');
 if(gate.lease.held)reasons.push('projector_lease_live');
 if(gate.window.live)reasons.push('window_live');
 if(gate.discoveryLease.live)reasons.push('discovery_lease_live');
 if(gate.discovery.mode==='d1'&&gate.discovery.cutover!=='open')reasons.push('discovery_held');
 if(gate.published.mode==='d1'&&gate.published.cutover!=='open')reasons.push('published_held');
 if(!['r2','d1'].includes(gate.discovery.mode)||!['r2','d1'].includes(gate.published.mode)||!['r2','d1'].includes(gate.owner.mode))reasons.push('authority_unknown');
 if(gate.owner.writes!=='open')reasons.push('owner_writes_held');
 return reasons;
}
const routes=gate=>({publishedEpg:gate.published.mode==='d1'&&gate.published.cutover==='open',discovery:gate.discovery.mode==='d1'&&gate.discovery.cutover==='open',ownerReview:gate.owner.mode==='d1'});
export function gateMoved(before,after){
 const reasons=[];
 for(const [name,reason] of [['schema','schema_moved'],['marker','marker_moved'],['fence','fence_moved'],['baseline','baseline_moved'],['window','window_moved'],['discovery','discovery_generation_moved'],['published','published_moved'],['owner','owner_moved']])if(stable(before[name])!==stable(after[name]))reasons.push(reason);
 if(after.lease.held)reasons.push('projector_lease_live_after');
 if(after.discoveryLease.live)reasons.push('discovery_lease_live_after');
 return reasons;
}

// ---------- the object checks ----------
const record=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const SHAPES={
 record,
 filmList:value=>record(value)&&Array.isArray(value.films),
 archive:value=>record(value)&&value.schemaVersion===1&&record(value.films),
 owner:value=>record(value)&&value.contractVersion===1&&record(value.films)&&record(value.people),
 pointer:value=>record(value)&&value.phase==='published'&&typeof value.programmeRunId==='string'&&RUN_ID.test(value.programmeRunId),
};
export function fenceRefusals(entry,value,nowMs){
 if(entry.id==='discoveryLease'&&Number(value?.expiresAt)>nowMs)return ['writer_active:discoveryLease'];
 if(entry.id==='sync'&&['metadata','epg'].includes(value?.stage)&&nowMs-Date.parse(value.updatedAt)<15*60000)return ['writer_active:sync'];
 return [];
}
const readBytes=async body=>Buffer.from(await new Response(body).arrayBuffer());
const sourceChanged=error=>error?.kind==='source_changed';

// One key: HEAD, GET If-Match, HEAD. Returns {entry} or {reason}. Never throws for an expected failure.
async function captureOne(client,item,key,{maxBytes}){
 let first;
 try{first=await client.head(key);}catch(error){return {reason:'probe_failed:'+item.id};}
 if(!first)return item.required?{reason:'missing:'+item.id}:{entry:{key,id:item.id,role:item.role,state:'absent',etag:null,size:null,sha256:null}};
 if(first.size>maxBytes)return {reason:'size_cap:'+item.id};
 let bytes;
 try{
  const response=await client.get(key,{ifMatch:first.etag});
  if(!response)return {reason:'etag_changed:'+item.id};
  if(response.etag!==first.etag||response.size!==first.size)return {reason:'etag_changed:'+item.id};
  bytes=await readBytes(response.body);
 }catch(error){return {reason:sourceChanged(error)?'etag_changed:'+item.id:'probe_failed:'+item.id};}
 if(bytes.length!==first.size)return {reason:'size_mismatch:'+item.id};
 let second;
 try{second=await client.head(key,{ifMatch:first.etag});}catch(error){return {reason:sourceChanged(error)?'etag_changed:'+item.id:'probe_failed:'+item.id};}
 if(!second||second.etag!==first.etag||second.size!==first.size)return {reason:'etag_changed:'+item.id};
 let value;
 try{value=JSON.parse(bytes.toString('utf8'));}catch{return {reason:'malformed:'+item.id};}
 if(!SHAPES[item.shape](value))return {reason:'malformed:'+item.id};
 return {entry:{key,id:item.id,role:item.role,state:'present',etag:first.etag,size:first.size,sha256:sha(bytes)},bytes,value};
}

// ---------- the capture ----------
// client: createReadOnlyClient(...) (or a test double with head/get). db: a D1 binding (or the sqlite stand-in). Result: {ok,reasons,manifest?,objects?,checkpoint?}.
// checkpoint (optional): the `checkpoint` of an earlier unfinished call; it is used ONLY if the D1 gate is unchanged and every stored key is still at its stored
// ETag, otherwise it is discarded whole and the capture starts again: one manifest never mixes two cuts. maxKeys bounds the keys read in one call.
export async function captureProjectorInputs({client,db,now=()=>new Date().toISOString(),maxBytes=MAX_OBJECT_BYTES,maxTotalBytes=MAX_TOTAL_BYTES,expectedSchema=SCHEMA_EXPECTED,checkpoint=null,maxKeys=Infinity,hooks={},source={bucket:'iptv'}}={}){
 const reasons=[],notes=[];
 const binding=readOnlyBinding(db);
 let runId=null;
 const limited=limitedClient(client,()=>runId);
 let gate0;
 try{
  gate0=await readCaptureGate(binding,{now});
  reasons.push(...gateRefusals(gate0,{expectedSchema}));
 }catch(error){return {ok:false,reasons:[error instanceof CaptureError?error.reason+(error.message.includes(': ')?':'+error.message.split(': ')[1]:''):'capture_error']};}
 if(reasons.length)return {ok:false,reasons,gate:gate0};
 const route=routes(gate0);
 let witness0;
 try{witness0=await readWitness(readerOf(binding));}catch(error){return {ok:false,reasons:['witness_unreadable'],gate:gate0};}
 // checkpoint reuse
 let entries=new Map(),bodies=new Map();
 if(checkpoint){
  const same=checkpoint.version===MANIFEST_VERSION&&stable(checkpoint.gate)===stable(gate0)&&checkpoint.allowlistDigest===allowlistDigest()&&checkpoint.source?.bucket===source.bucket;
  let ok=same;
  if(ok){
   runId=checkpoint.runId??null;
   for(const entry of checkpoint.entries){
    if(!isAllowed(entry.key,runId)){ok=false;break;}
    let current=null;try{current=await limited.head(entry.key);}catch{ok=false;break;}
    if(entry.state==='present'?(!current||current.etag!==entry.etag||current.size!==entry.size):current!==null){ok=false;break;}
   }
  }
  if(ok){for(const entry of checkpoint.entries){entries.set(entry.key,entry);if(checkpoint.bodies?.[entry.key]!==undefined)bodies.set(entry.key,Buffer.from(checkpoint.bodies[entry.key],'base64'));}}
  else{notes.push('checkpoint_discarded');runId=null;}
 }
 let total=[...entries.values()].reduce((sum,entry)=>sum+(entry.size||0),0),read=0;
 const parsed={};
 for(const [key,bytes] of bodies){const item=ALLOWLIST.find(entry=>entry.key===key||entry.template&&isAllowed(key,runId)&&resolveKey(entry,runId)===key);if(item)parsed[item.id]=JSON.parse(bytes.toString('utf8'));}
 // keys the capture requests over R2: a D1-routed input is NOT requested; the fence keys are always requested
 const wanted=item=>!(item.gate&&route[item.gate]);
 for(const item of ALLOWLIST.filter(wanted)){
  if(item.template&&!runId){
   // the generation a templated key names comes from the pointer (R2) or from the published authority row (D1)
   if(route.publishedEpg)runId=gate0.published.programmeRunId;
   else if(parsed.publishedPointer)runId=parsed.publishedPointer.programmeRunId;
   if(!runId||!RUN_ID.test(runId)){reasons.push('run_id_unknown');break;}
  }
  const key=resolveKey(item,runId);
  if(entries.has(key))continue;
  if(read>=maxKeys)return {ok:false,done:false,reasons:['checkpoint'],checkpoint:{version:MANIFEST_VERSION,gate:gate0,allowlistDigest:allowlistDigest(),source,runId,entries:[...entries.values()],bodies:Object.fromEntries([...bodies].map(([k,v])=>[k,v.toString('base64')]))}};
  if(hooks.beforeKey)await hooks.beforeKey(key);
  const result=await captureOne(limited,item,key,{maxBytes});
  read++;
  if(result.reason){reasons.push(result.reason);break;}
  total+=result.entry.size||0;
  if(total>maxTotalBytes){reasons.push('size_cap:total');break;}
  entries.set(key,result.entry);
  if(result.bytes){bodies.set(key,result.bytes);parsed[item.id]=result.value;}
  reasons.push(...(result.value?fenceRefusals(item,result.value,Date.parse(now())):[]));
  if(reasons.length)break;
 }
 if(!runId&&route.publishedEpg)runId=gate0.published.programmeRunId;
 if(reasons.length)return {ok:false,reasons,gate:gate0};
 // the D1-derived inputs, by the projector's own readers behind the read-only guard
 const log=[];
 const env=derivedEnv(db,log);
 const derived={},derivedValues={};
 try{
  if(hooks.beforeD1)await hooks.beforeD1();
  if(route.publishedEpg){
   const snapshot=await PublishedEpg.authoritativeSnapshot(env);
   if(!snapshot||snapshot.programmeRunId!==runId||!SHAPES.filmList(snapshot.programme)||!SHAPES.filmList(snapshot.watchlist))throw capError('published_unavailable');
   derivedValues.publishedEpg=snapshot;derived.publishedEpg={generation:snapshot.generation,programmeRunId:snapshot.programmeRunId,sha256:sha(stable({programme:snapshot.programme,watchlist:snapshot.watchlist}))};
  }
  if(route.discovery){
   const catalogKey=resolveKey(ALLOWLIST.find(item=>item.id==='catalog'),runId);
   for(const [id,key] of [['discoveryCatalog',catalogKey],['discoveryResolution','epg/discovery-resolution.json']]){
    const routed=await DiscoveryAuthority.routeRead(env,key);
    if(!routed?.handled||!record(routed.value))throw capError(id==='discoveryCatalog'?'generation_pending':'missing',id);
    derivedValues[id]=routed.value;derived[id]={sha256:sha(stable(routed.value)),entries:Object.keys(routed.value).length};
   }
  }
  if(route.ownerReview){
   const snapshot=await OwnerReview.readFenced(env);
   if(!snapshot?.ok||snapshot.mode!=='d1'||snapshot.generation!==gate0.owner.generation||!SHAPES.owner(snapshot.body))throw capError('owner_review_unavailable');
   derivedValues.ownerReviews=snapshot.body;derived.ownerReviews={generation:snapshot.generation,sha256:sha(stable(snapshot.body))};
  }
 }catch(error){return {ok:false,reasons:[error instanceof CaptureError?error.reason:'d1_derived_failed'],gate:gate0};}
 // after: the D1 gate and witness again, then every ETag once more (the projector's own etagRecheck, after the D1 reads)
 let gate1,witness1;
 try{gate1=await readCaptureGate(binding,{now});witness1=await readWitness(readerOf(binding));}catch(error){return {ok:false,reasons:['gate_unreadable_after'],gate:gate0};}
 reasons.push(...gateMoved(gate0,gate1));
 if(stable(witness0)!==stable(witness1))reasons.push('witness_moved');
 for(const entry of entries.values()){
  let current=null;
  try{current=await limited.head(entry.key);}catch{reasons.push('probe_failed_after:'+entry.id);continue;}
  if(entry.state==='present'?(!current||current.etag!==entry.etag):current!==null)reasons.push('etag_changed_after:'+entry.id);
 }
 if(reasons.length)return {ok:false,reasons,gate:gate0};
 const objects=[...entries.values()].sort((a,b)=>a.key<b.key?-1:1);
 const core={manifestVersion:MANIFEST_VERSION,kind:'film-person-projector-input',source:{kind:'cloudflare-r2-s3',bucket:source.bucket,readOnly:true},allowlistDigest:allowlistDigest(),runId,routes:route,objects,derived,d1:{before:gate0,after:gate1},witness:{before:witness0,after:witness1}};
 const manifest={...core,digest:sha(stable(core)),capturedAt:now(),notCovered:NOT_COVERED};
 return {ok:true,reasons:[],manifest,bodies:Object.fromEntries([...bodies].map(([k,v])=>[k,v])),derivedValues,statements:log.length};
}
// The env the projector's readers get for the D1-derived inputs: a read-only DB and a bucket that refuses every read (the D1-owned inputs never come from R2).
export const derivedEnv=(db,log=null)=>({DB:readOnlyBinding(db,log),BUCKET:{get:async key=>{throw capError('r2_read_in_d1_derived',key);},head:async key=>{throw capError('r2_read_in_d1_derived',key);}}});
export const NOT_COVERED=Object.freeze(['equal R2 ETags do not prove a consistent R2+D1 snapshot','writers that bypass the projector lease','inputs that move between the R2 reads and the D1 reads','D1-owned inputs changing between their read and the stage A cut']);
export function verifyManifest(manifest,bodies){
 const reasons=[];
 if(!manifest||manifest.manifestVersion!==MANIFEST_VERSION)return ['manifest_version'];
 const {digest,capturedAt,notCovered,...core}=manifest;
 if(sha(stable(core))!==digest)reasons.push('manifest_digest');
 if(manifest.allowlistDigest!==allowlistDigest())reasons.push('allowlist_changed');
 for(const entry of manifest.objects||[]){
  if(!isAllowed(entry.key,manifest.runId))reasons.push('key_not_allowlisted');
  else if(entry.state==='present'&&(!bodies?.[entry.key]||sha(bodies[entry.key])!==entry.sha256))reasons.push('object_digest:'+entry.id);
 }
 return reasons;
}

// ---------- source identity and derived-payload binding ----------
// The D1 identity a manifest was captured against: every field that decides which D1 generation the derived inputs and the ledger describe. A parity run compares
// it with a FRESH read and refuses on any difference, naming the field and never a value. Leases and windows are not identity: they are refused while live.
const IDENTITY_FIELDS=['schema','marker','fence','baseline','discovery','published','owner'];
export const identityOf=gate=>Object.fromEntries(IDENTITY_FIELDS.map(name=>[name,gate?.[name]??null]));
const leaves=(value,prefix='',out=new Map())=>{if(value&&typeof value==='object'&&!Array.isArray(value)){for(const key of Object.keys(value))leaves(value[key],prefix?prefix+'.'+key:key,out);}else out.set(prefix,stable(value));return out;};
export function identityMoved(recorded,fresh,suffix=''){
 const a=leaves(identityOf(recorded)),b=leaves(identityOf(fresh)),reasons=[];
 for(const key of new Set([...a.keys(),...b.keys()]))if(a.get(key)!==b.get(key))reasons.push('d1_identity_moved'+suffix+':'+key);
 return reasons.sort();
}
const DERIVED_DIGEST={publishedEpg:v=>stable({programme:v.programme,watchlist:v.watchlist}),discoveryCatalog:v=>stable(v),discoveryResolution:v=>stable(v),ownerReviews:v=>stable(v)};
// Every routed derived payload must match its recorded digest AND the recorded source generation / run identity; nothing may be missing or extra.
export function verifyDerived(manifest,derivedValues){
 const reasons=[],recorded=manifest.derived||{},supplied=derivedValues||{},after=manifest.d1?.after;
 for(const id of Object.keys(recorded)){
  if(!(id in DERIVED_DIGEST)){reasons.push('derived_unknown:'+id);continue;}
  if(!(id in supplied)||supplied[id]===null||supplied[id]===undefined){reasons.push('derived_missing:'+id);continue;}
  const value=supplied[id];
  let digest;try{digest=sha(DERIVED_DIGEST[id](value));}catch{reasons.push('derived_digest:'+id);continue;}
  if(digest!==recorded[id].sha256)reasons.push('derived_digest:'+id);
  if(id==='publishedEpg'&&(value.generation!==recorded[id].generation||value.programmeRunId!==recorded[id].programmeRunId||recorded[id].generation!==after?.published?.generation||recorded[id].programmeRunId!==after?.published?.programmeRunId||recorded[id].programmeRunId!==manifest.runId))reasons.push('derived_identity:'+id);
  if(id==='ownerReviews'&&(recorded[id].generation!==after?.owner?.generation))reasons.push('derived_identity:'+id);
 }
 for(const id of Object.keys(supplied))if(!(id in recorded))reasons.push('derived_extra:'+id);
 const routed={publishedEpg:manifest.routes?.publishedEpg,discoveryCatalog:manifest.routes?.discovery,discoveryResolution:manifest.routes?.discovery,ownerReviews:manifest.routes?.ownerReview};
 for(const id of Object.keys(routed))if(!!routed[id]!==(id in recorded))reasons.push('derived_route_mismatch:'+id);
 return [...new Set(reasons)].sort();
}

// ---------- the expected side: the projector's own view ----------
// The inputs of d1EnrichmentStore, rebuilt from a verified manifest, its bodies and the D1-derived values; then the same calls the projector makes.
export function buildExpected({manifest,bodies,derivedValues,asOf}){
 const get=id=>{const entry=manifest.objects.find(item=>item.id===id);return entry&&entry.state==='present'?JSON.parse(Buffer.from(bodies[entry.key]).toString('utf8')):null;};
 const published=derivedValues.publishedEpg;
 const watchlist=published?published.watchlist:get('watchlist'),programme=published?published.programme:get('programme');
 const owner=derivedValues.ownerReviews??get('ownerMirror');
 if(owner){stampLocalized(programme,owner);stampLocalized(watchlist,owner);}
 const store=enrichmentStore({watchlist,programme,metadata:get('metadata'),titles:get('titles'),people:get('people'),discoveredFilms:derivedValues.discoveryCatalog??get('catalog'),discoveryResolution:derivedValues.discoveryResolution??get('resolution'),diaryHistory:get('diary'),tmdbRetirements:get('retirements'),watchlistAdmissions:watchlistAdmissionsFromIndex(get('viewIndex')),archiveAdmissions:get('verifiedFilms')?archiveAdmissionsFromDocument(get('verifiedFilms')):null,filmTitles:JSON.parse(fs.readFileSync(path.join(ROOT,'data/film-titles.json'),'utf8')),personNames:JSON.parse(fs.readFileSync(path.join(ROOT,'data/person-names.json'),'utf8')),personOverrides:{'actor/chris-pratt':personOverridesFromSource(fs.readFileSync(path.join(ROOT,'src/sources.js'),'utf8'))['actor/chris-pratt']}});
 if(owner)store.ownerReviews=owner;
 const now=Date.parse(asOf);
 const view=lifecycleReader()(store,now);
 const retirements=view.tmdbRetirements||null;
 if(owner)applyViewOverlay(view,owner);
 if(retirements&&!retirements.valid)throw capError('retirements_invalid');
 const inputs=enrichmentInputs({view,store});
 return {inputs,view,store,retirements,body:{retirements:get('retirements'),owner}};
}
// The classes the view does not carry, from the same inputs. ownerLink is classified by the D1 writer (identity_link / identity_state) and is NOT derivable offline:
// it stays unavailable on the expected side, so the ledger is never complete until an owner decision covers it (reported, never hidden).
export function extraClasses({inputs,store,body,asOf}){
 const extra={};
 const films=inputs.films;
 const tmdbOf=film=>(film.film?.externalIds||[]).find(item=>item.scheme==='tmdb')?.value;
 const byTmdb=new Map(films.map(film=>[String(tmdbOf(film)),film.id]));
 extra.retirement=(body.retirements?.retirements||[]).filter(item=>item&&typeof item.filmId==='string').map(item=>[item.filmId,['retire',item.movieId,item.tvId]]);
 const archive=store.archiveAdmissions||{};
 const admitted=[];
 for(const item of Object.values(archive)){const id=byTmdb.get(String(item.tmdb));if(id)admitted.push([id,[item.tmdb,item.sourceCode,item.archiveSha256]]);}
 extra.ratedAdmission=admitted;
 const lists=store.watchlistAdmissions||{};
 extra.retention=films.flatMap(film=>{const lid=(film.film?.externalIds||[]).find(item=>item.scheme==='letterboxd')?.value;return lid&&typeof lists[lid]==='boolean'?[[film.id,[lists[lid]?1:0]]]:[];});
 extra.projectionKey=[...inputs.people.map(entry=>[keyOf('person',entry.id),[personChangeKey(entry,asOf)]]),...films.map(entry=>[keyOf('film',entry.id),[filmChangeKey(entry,asOf)]])];
 return extra;
}

// ---------- diagnostics: NEVER automatic exceptions ----------
// They classify and count; ids appear only as 12-hex hashes. They add nothing to the ledger's explanations and create no exception (an exception keeps the
// existing owner shape {class,key,reason,approvedBy}); the ledger digest is computed before and without them.
const SEP='\u001f';
const PREDICTION_FACT_TABLES=['candidate_decision','candidate_decision_history','fingerprint_payload','prediction_current','prediction_history'];
export const factsSql=()=>PREDICTION_FACT_TABLES.map(table=>"SELECT '"+table+"' AS held FROM (SELECT 1 FROM "+table+' WHERE film_id=? LIMIT 1)').join(' UNION ALL ');
export const FACT_TABLES=PREDICTION_FACT_TABLES;
const bump=(map,name,id)=>{const entry=map[name]||(map[name]={count:0,hashes:[]});entry.count++;if(entry.hashes.length<LIST_CAP)entry.hashes.push(shortHash(id));};
const mapOf=list=>new Map((list||[]).map(([key,value])=>[key,value]));
// (a) Person projector keys D1 stores although the view has no such Person. Candidate cause, first match wins.
export function diagnosePersonKeys({expected,actual}){
 const view=new Set((expected.classes.person||[]).map(([id])=>id));
 const keyed=(actual.classes.projectionKey||[]).map(([key])=>key.split(SEP)).filter(parts=>parts[0]==='person').map(parts=>parts[1]);
 const extra=keyed.filter(id=>!view.has(id));
 const rows=mapOf(actual.classes.person),viewRoles=new Map((expected.classes.person||[]).map(([id,value])=>[JSON.parse(value)[0],id]));
 const expectedExternal=new Map();
 for(const [key] of expected.classes.personExternalId||[]){const [owner,...rest]=key.split(SEP);expectedExternal.set(rest.join(SEP),owner);}
 const actualExternal=new Map();
 for(const [key] of actual.classes.personExternalId||[]){const [owner,...rest]=key.split(SEP);(actualExternal.get(owner)||actualExternal.set(owner,[]).get(owner)).push(rest.join(SEP));}
 const retiredFilms=new Set([...(actual.classes.redirect||[]).map(([from])=>from),...(expected.classes.retirement||[]).map(([id])=>id)]);
 const creditFilms=new Map();
 for(const [key] of actual.classes.credit||[]){const [film,person]=key.split(SEP);(creditFilms.get(person)||creditFilms.set(person,[]).get(person)).push(film);}
 const causes={};
 for(const id of extra){
  const row=rows.get(id);
  let cause;
  if(!row)cause='key_without_person_row';
  else if(viewRoles.has(JSON.parse(row)[0])&&viewRoles.get(JSON.parse(row)[0])!==id)cause='renamed_id';
  else if((actualExternal.get(id)||[]).some(external=>expectedExternal.has(external)&&expectedExternal.get(external)!==id))cause='merged_or_deduplicated';
  else if((creditFilms.get(id)||[]).length>0&&creditFilms.get(id).every(film=>retiredFilms.has(film)))cause='retired';
  else cause='removed_from_sources';
  bump(causes,cause,id);
 }
 return {keyedPersons:keyed.length,viewPersons:view.size,absentFromView:extra.length,causes};
}
// (b) every D1 redirect against the expected side: an expected redirect, a retirement the owner confirmed (from or to), or no expected source at all.
export function diagnoseRedirects({expected,actual,redirectRows=[]}){
 const exp=mapOf(expected.classes.redirect),retired=new Set((expected.classes.retirement||[]).map(([id])=>id));
 const at=new Map(redirectRows.map(row=>[row.from_id,row.at]));
 const out={actual:(actual.classes.redirect||[]).length,expectedRedirects:exp.size,expectedRetirements:retired.size,items:[],byClass:{},retirementsWithoutRedirect:0};
 const seen=new Set();
 for(const [from,value] of actual.classes.redirect||[]){
  const to=JSON.parse(value)[0];
  const kind=exp.has(from)&&exp.get(from)===value?'expected_redirect':(retired.has(from)||retired.has(to))?'corresponds_to_retirement':'no_expected_source';
  seen.add(from);seen.add(to);
  out.byClass[kind]=(out.byClass[kind]||0)+1;
  out.items.push({from:shortHash(from),to:shortHash(to),kind,at:at.get(from)??null});
 }
 out.retirementsWithoutRedirect=[...retired].filter(id=>!seen.has(id)).length;
 out.batchAt=[...new Set(out.items.map(item=>item.at).filter(Boolean))].sort();
 return out;
}
// (c) Films whose change key differs from the stored one: retained duplicate (an expected redirect whose old Film D1 still holds, with prediction facts =
// the projector's `duplicate_film_retained`), changed but unwritten (the same without facts) or other. `factsOf(filmId)` is the projector's own SQL (factsSql,
// drift-tested against src/canonical-repository.js), read-only.
export async function diagnoseChangedFilms({inputs,actual,factsOf,asOf}){
 const stored=new Map((actual.classes.projectionKey||[]).map(([key,value])=>{const [kind,id]=key.split(SEP);return [kind+SEP+id,JSON.parse(value)[0]];}));
 const films=new Set((actual.classes.film||[]).map(([id])=>id));
 const out={changed:0,classes:{}};
 for(const entry of inputs.films){
  if(stored.get('film'+SEP+entry.id)===filmChangeKey(entry,asOf))continue;
  out.changed++;
  const from=(entry.film?.redirects||[]).map(item=>item.from||item.id).filter(id=>films.has(id));
  let cause='other';
  if(from.length){
   cause='changed_but_unwritten';
   for(const id of from)if((await factsOf(id)).length){cause='retained_duplicate';break;}
  }
  bump(out.classes,cause,entry.id);
 }
 return out;
}

// ---------- the parity report ----------
// manifest + bodies + derivedValues come from a successful capture; db is the D1 binding for the stage A stable cut (which takes the projector lease: the ONE D1
// write of a parity run, kept apart from the capture and under its own owner GO). The result is a measurement report: its source is never `verified`, so
// baselineGate refuses it.
export async function runParity({manifest,bodies,derivedValues,db,client,leaseId,asOf,exceptions=[],personExceptions=[],now=()=>new Date().toISOString(),hooks={}}){
 const bad=verifyManifest(manifest,bodies);
 if(bad.length)return {ok:false,reasons:bad.map(item=>'manifest_invalid:'+item)};
 const unbound=verifyDerived(manifest,derivedValues);
 if(unbound.length)return {ok:false,reasons:unbound.map(item=>'derived_invalid:'+item)};
 // the manifest's recorded D1 identity must still be the live one, before the cut and again after it (fail closed on any difference)
 const reasons=[];
 const binding=readOnlyBinding(db);
 let fresh0;try{fresh0=await readCaptureGate(binding,{now});}catch{return {ok:false,reasons:['gate_unreadable_before_cut']};}
 const moved0=identityMoved(manifest.d1?.after,fresh0);
 if(fresh0.lease.held)moved0.push('projector_lease_live');
 if(fresh0.window.live)moved0.push('window_live');
 if(fresh0.discoveryLease.live)moved0.push('discovery_lease_live');
 
 let witnessA=null;try{witnessA=await readWitness(readerOf(binding));}catch{}
 let built;
 try{built=buildExpected({manifest,bodies,derivedValues,asOf});}catch(error){return {ok:false,reasons:[error instanceof CaptureError?error.reason:'view_failed']};}
 const classes=expectedFromInputs(built.inputs,extraClasses({...built,asOf}));
 if(hooks.beforeCut)await hooks.beforeCut();
 const cut=await readStableCut(readerOf(db),{leaseId,now});
 if(hooks.afterCut)await hooks.afterCut();
 if(!cut.consistent)return {ok:false,reasons:['cut_not_consistent',...cut.reasons]};
 let fresh1;try{fresh1=await readCaptureGate(binding,{now});}catch{return {ok:false,reasons:['gate_unreadable_after_cut']};}
 const moved1=identityMoved(manifest.d1?.after,fresh1,'_after_cut');
 if(moved1.length)return {ok:false,reasons:moved1};
 // the ETags once more, after the D1 cut
 const limited=limitedClient(client,()=>manifest.runId);
 for(const entry of manifest.objects){
  let current=null;try{current=await limited.head(entry.key);}catch{reasons.push('probe_failed_after_cut:'+entry.id);continue;}
  if(entry.state==='present'?(!current||current.etag!==entry.etag):current!==null)reasons.push('etag_changed_after_cut:'+entry.id);
 }
 const expected={classes,unavailable:['ownerLink'],complete:true};
 const actual={classes:cut.entries,unavailable:cut.unavailable,consistent:reasons.length===0};
 const context=contextFromActual({classes:cut.entries},{air286:cut.air286.verified,personExceptions});
 const {ledger}=await buildParityLedger({expected,actual,exceptions,context,source:{aggregateSha256:manifest.digest,verified:false,kind:'projector-input-capture'}});
 // The diagnostics run AFTER the cut released its lease: they are a SEPARATE observation, witnessed before and after so a write in between is flagged.
 const reader=readerOf(binding);
 if(hooks.afterLedger)await hooks.afterLedger();
 let witnessB=null;
 const factsOf=async id=>(await reader.all(factsSql(),PREDICTION_FACT_TABLES.map(()=>id))).map(row=>row.held);
 let redirectRows=[];try{redirectRows=await reader.all('SELECT from_id, to_film_id, at FROM film_redirect ORDER BY from_id');}catch{}
 const exp={classes},act={classes:cut.entries};
 const diagnostics={cut:'separate_observation',personKeys:diagnosePersonKeys({expected:exp,actual:act}),redirects:diagnoseRedirects({expected:exp,actual:act,redirectRows}),changedFilms:await diagnoseChangedFilms({inputs:built.inputs,actual:act,factsOf,asOf}),note:'diagnostics classify and count; none is an exception'};
 try{witnessB=await readWitness(reader);}catch{}
 diagnostics.stable=!!witnessA&&!!witnessB&&stable(witnessA)===stable(witnessB);
 if(!diagnostics.stable)diagnostics.note+='; D1 moved during the diagnostics reads: they describe a different state than the ledger';
 const coverage=Object.fromEntries(CLASSES.map(item=>{const entry=ledger.classes[item.name];return [item.name,entry.unavailable?{unavailable:true}:{expected:entry.expected.count,actual:entry.actual.count,missing:entry.missing,extra:entry.extra,differs:entry.differs,explained:entry.explained.total,unexplained:entry.unexplained.total,expectedDigest:entry.expected.digest,actualDigest:entry.actual.digest}];}));
 const core={reportVersion:REPORT_VERSION,measurement:true,authorizes:'nothing',manifestDigest:manifest.digest,ledgerDigest:ledger.digest,ledgerVersion:LEDGER_VERSION,asOf,totals:ledger.totals,coverage,diagnostics,notCovered:NOT_COVERED,consistent:reasons.length===0};
 return {ok:reasons.length===0,reasons,ledger,report:{...core,digest:sha(stable(core))}};
}
