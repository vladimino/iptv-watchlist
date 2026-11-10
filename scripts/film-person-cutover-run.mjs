// AIR-373 (ADR 0099, Accepted; coordinator decision of 10 Nov 2026): ONE measuring operation for the `cutover_minimum` gate = the narrow projector-input capture
// (scripts/film-person-capture.mjs) + the stage A stable cut of D1, with exactly one D1 write: the projector lease row of the cut. OFFLINE and INACTIVE: not bundled
// (build.mjs lists no such file), no Worker import, no route, cron or job, no CLI, no side effect at import. It records nothing and moves no marker: recording is
// `recordBaselineVerified` with the explicit cutover_minimum path, a separate owner GO, and r2 -> prepared is another one.
//
// WHERE `verified:true` COMES FROM. The ledger's `source.verified` is not a parameter of this module and no caller can pass it. It is computed at the end of a run:
//  (1) deriveEvidence(run): every check below is made on values this run itself OBSERVED (re-read, not copied) and any failure refuses the run with NO ledger:
//      - manifest: verifyManifest and verifyDerived are empty (the allowlist digest is the current one, every body and every D1-routed payload matches its sha256);
//      - probe complete: the manifest holds exactly one entry per allowlisted key the routes require, at the key the run id resolves to, present (with ETag and
//        sha256) or absent only when optional, and nothing else; every key was HEADed again after the D1 cut; the cut read every class to the end;
//      - R2 ETags: the list observed by HEAD after the D1 cut equals the captured list, key by key (the capture already held each at one ETag across its own
//        HEAD / GET If-Match / HEAD and its final HEAD);
//      - D1 identity: schema, marker (mode, cutover, generation), fence, baseline, Discovery, published EPG and owner-review authority are equal at four reads:
//        capture start, capture end, before the cut, after the cut;
//      - witness: the stage A content witness is equal at the same four points;
//      - fence and lease continuity: the fence row is ok at all four reads; no foreign projector lease, window or Discovery lease is live at any of them; the cut
//        held OUR lease from its first read to its last (readStableCut renews and re-checks it at every page) and ended consistent;
//      - owner-review facts: a count and a digest of the manual entries (never the link values), equal before the capture and after the cut.
//  (2) transport provenance: the R2 client and the D1 binding must be the very objects `openProductionSource` built for the production endpoints
//      (https://<account>.r2.cloudflarestorage.com, bucket `iptv`, no endpoint override; the Cloudflare D1 API, database `iptv`, no endpoint override), both on
//      the platform `fetch` (that function takes no transport), and the D1 API must then describe the database as `iptv` with the configured id.
// WHAT DISTINGUISHES A REAL RUN FROM A SYNTHETIC ONE is (2) and only (2): a synthetic run can satisfy every check of (1) against the sqlite stand-in and a loopback
// S3 server, so (1) alone must never be enough. A test double, the sqlite stand-in, a client built with an endpoint override (loopback included) or with an injected
// `fetch` is not in the private registry, so such a run ends `verified:false` with `source_transport_not_production:*` and both gates refuse its ledger.
// THE HONEST LIMIT. This is provenance by construction inside one process, not a proof: offline code has no root of trust, a ledger is a plain object, and someone
// who writes `verified:true` into one by hand, or replaces the global `fetch` before opening the source, is not stopped by this module. It prevents an ACCIDENTAL
// verified:true (a fixture, a rehearsal, a partial or ambiguous run), it does not authenticate a ledger. The production path through the real transports has never
// been executed: no test reaches it, and it needs its own owner GO.
// An interrupted run is not resumed here (no checkpoint): a second attempt is a new run with a new manifest.
import {createHash} from 'node:crypto';
import {contextFromActual,expectedFromInputs,readStableCut,readWitness,readerOf} from '../src/film-person-baseline.js';
import {CUTOVER_MINIMUM_GATE,CUTOVER_MINIMUM_VERSION,OWNER_LINK_WAIVER,buildCutoverMinimumLedger,cutoverMinimumGate} from '../src/film-person-cutover-minimum.js';
import {ALLOWLIST,CaptureError,buildExpected,captureProjectorInputs,extraClasses,identityMoved,identityOf,limitedClient,readCaptureGate,readOnlyBinding,resolveKey,verifyDerived,verifyManifest} from './film-person-capture.mjs';
import {createReadOnlyClient,readCredentials} from './r2-snapshot-export.mjs';
import {DEFAULT_ENDPOINT,TARGET_DATABASE_NAME,createD1Adapter,readTarget} from './d1-backfill.mjs';

export const RUN_VERSION=1;
export const PRODUCTION_BUCKET='iptv';
export const OWNER_FACTS_CAP=20000;
export const OWNER_FACTS_SQL='SELECT kind, source_key, payload_json, generation FROM owner_review_entry ORDER BY kind, source_key LIMIT '+(OWNER_FACTS_CAP+1);
const HEX64=/^[0-9a-f]{64}$/;
const stable=value=>JSON.stringify(value,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const sha=text=>createHash('sha256').update(text).digest('hex');
const record=value=>!!value&&typeof value==='object'&&!Array.isArray(value);

// ---------- transport provenance ----------
// The registry is private to this module and is written only by openProductionSource. Nothing exported can add an entry.
const PRODUCTION=new WeakMap();
export const transportKind=value=>(record(value)&&PRODUCTION.get(value)?.kind)||null;
// A D1 binding (prepare / bind / first / all / run) over the D1 HTTP adapter of scripts/d1-backfill.mjs. `run` is needed for the one write of a run, the lease row.
export function bindingOfAdapter(adapter){
 const statement=(sql,params)=>({first:()=>adapter.get(sql,params),all:async()=>({results:await adapter.all(sql,params)}),run:()=>adapter.run(sql,params)});
 return {prepare(sql){return {bind:(...params)=>statement(sql,params),...statement(sql,[])};}};
}
// Builds the two transports from the local environment (R2_SNAPSHOT_* read-only, D1_BACKFILL_*) and sends NOTHING. It takes no `fetch`, endpoint or flag argument:
// a transport is registered as production only when the environment itself names the production endpoint, bucket and database with no override. Anything else
// (a loopback rehearsal) still gets working transports, unregistered, so its run is a measurement with `verified:false`.
export function openProductionSource(env){
 const credentials=readCredentials(env),target=readTarget(env);
 const client=createReadOnlyClient({credentials});
 const adapter=createD1Adapter({target,databaseId:target.databaseId});
 const db=bindingOfAdapter(adapter);
 const r2=!credentials.endpointOverride&&credentials.bucket===PRODUCTION_BUCKET&&credentials.endpoint==='https://'+credentials.accountId+'.r2.cloudflarestorage.com';
 const d1=!target.endpointOverride&&target.endpoint===DEFAULT_ENDPOINT&&target.databaseName===TARGET_DATABASE_NAME;
 if(r2)PRODUCTION.set(client,{kind:'r2'});
 if(d1)PRODUCTION.set(db,{kind:'d1',databaseId:target.databaseId,describe:()=>adapter.describe()});
 return {client,db,production:{r2,d1}};
}
// Why a run is not a production run (empty = it is). The D1 API is asked to describe the database only when the binding is a registered one.
export async function transportReasons(client,db){
 const reasons=[];
 if(transportKind(client)!=='r2')reasons.push('source_transport_not_production:r2');
 if(transportKind(db)!=='d1')reasons.push('source_transport_not_production:d1');
 else{
  const entry=PRODUCTION.get(db);
  let seen=null;try{seen=await entry.describe();}catch{seen=null;}
  if(!(seen&&seen.name===TARGET_DATABASE_NAME&&seen.uuid===entry.databaseId))reasons.push('source_transport_identity:d1');
 }
 return reasons;
}

// ---------- the evidence of one run ----------
const STAGES=['captureBefore','captureAfter','parityBefore','parityAfter'];
const etagLine=item=>[item.key,item.state,item.etag??null];
export const etagDigest=list=>sha(stable(list.map(etagLine).sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0)));
// Pure. `run` is the record runCutoverMinimum collected (every field an observation of that run). Returns the reasons the run is not a clean cut and the evidence
// the cutover_minimum ledger carries; the three flags are DERIVED from the reasons, they are not inputs.
export function deriveEvidence(run){
 const reasons=[];
 const manifest=run?.manifest;
 if(!record(manifest)||!HEX64.test(String(manifest.digest||''))||!Array.isArray(manifest.objects))return {reasons:['manifest_missing'],evidence:null};
 for(const item of run.manifestProblems||['unchecked'])reasons.push('manifest_invalid:'+item);
 for(const item of run.derivedProblems||['unchecked'])reasons.push('derived_invalid:'+item);
 // probe completeness: exactly the allowlisted keys the routes require, each at its resolved key
 const known=new Set(ALLOWLIST.map(item=>item.id));
 for(const entry of manifest.objects)if(!known.has(entry?.id))reasons.push('probe_incomplete:unknown_object');
 for(const item of ALLOWLIST){
  const found=manifest.objects.filter(entry=>entry?.id===item.id);
  if(item.gate&&manifest.routes?.[item.gate]===true){if(found.length)reasons.push('probe_incomplete:routed_object:'+item.id);continue;}
  let key=null;try{key=resolveKey(item,manifest.runId);}catch{key=null;}
  const entry=found[0];
  if(found.length!==1||key===null||entry.key!==key)reasons.push('probe_incomplete:'+item.id);
  else if(entry.state==='present'){if(typeof entry.etag!=='string'||!entry.etag||!HEX64.test(String(entry.sha256||'')))reasons.push('probe_incomplete:'+item.id);}
  else if(entry.state!=='absent'||item.required)reasons.push('probe_incomplete:'+item.id);
 }
 // R2 ETags after the D1 cut, key by key
 const after=Array.isArray(run.etagsAfterCut)?run.etagsAfterCut:[];
 const seen=new Map(after.map(item=>[item?.key,item]));
 if(after.length!==manifest.objects.length)reasons.push('probe_incomplete:etags_after_cut');
 for(const entry of manifest.objects){
  const now=seen.get(entry.key);
  if(!now||now.error===true||!['present','absent'].includes(now.state))reasons.push('probe_incomplete:etag_after_cut:'+entry.id);
  else if(now.state!==entry.state||(now.etag??null)!==(entry.etag??null))reasons.push('etag_changed_after_cut:'+entry.id);
 }
 // D1 identity, fence and foreign leases at the four reads
 const gates=run.gates||{};
 for(const stage of STAGES){
  const gate=gates[stage];
  if(!record(gate)){reasons.push('d1_identity_missing:'+stage);continue;}
  for(const item of identityMoved(gates.captureBefore,gate))reasons.push(item.replace('d1_identity_moved:','d1_identity_moved:'+stage+':'));
  if(gate.fence?.ok!==1)reasons.push('fence_lost:'+stage);
  if(gate.lease?.held!==false)reasons.push('lease_foreign:projector:'+stage);
  if(gate.window?.live!==false)reasons.push('lease_foreign:window:'+stage);
  if(gate.discoveryLease?.live!==false)reasons.push('lease_foreign:discovery:'+stage);
 }
 // the stage A cut and our lease across it
 const cut=run.cut||{};
 if(cut.done!==true)reasons.push('probe_incomplete:cut');
 if(cut.consistent!==true)reasons.push('cut_not_consistent');
 for(const item of Array.isArray(cut.reasons)?cut.reasons:['cut_reasons_missing'])reasons.push(/^lease_/.test(item)?'lease_lost:'+item:'cut:'+item);
 for(const name of Array.isArray(cut.unavailable)?cut.unavailable:['unknown'])reasons.push('probe_incomplete:class:'+name);
 if(typeof run.leaseId!=='string'||!run.leaseId||cut.leaseBefore?.id!==run.leaseId||cut.leaseBefore?.live!==true)reasons.push('lease_lost:not_held_at_start');
 if(typeof run.leaseId!=='string'||!run.leaseId||cut.leaseAfter?.id!==run.leaseId||cut.leaseAfter?.live!==true)reasons.push('lease_lost:not_held_at_end');
 // the witness at the four points
 const witness=run.witness||{};
 for(const stage of STAGES){
  if(!record(witness[stage]))reasons.push('witness_unreadable:'+stage);
  else if(stable(witness[stage])!==stable(witness.captureBefore))reasons.push('witness_moved:'+stage);
 }
 // the manual owner-review facts
 const facts=run.ownerFacts||{};
 const factsOk=item=>record(item)&&Number.isInteger(item.count)&&HEX64.test(String(item.digest||''));
 if(!factsOk(facts.before)||!factsOk(facts.after))reasons.push('owner_facts_unreadable');
 else if(stable(facts.before)!==stable(facts.after))reasons.push('owner_facts_changed');
 const any=pattern=>reasons.some(item=>pattern.test(item));
 const evidence={
  manifestDigest:manifest.digest,
  r2Etags:{before:etagDigest(manifest.objects),after:etagDigest(after.filter(item=>record(item)&&typeof item.key==='string'))},
  d1:{before:record(gates.captureBefore)?identityOf(gates.captureBefore):null,after:record(gates.parityAfter)?identityOf(gates.parityAfter):null},
  witness:{before:witness.captureBefore??null,after:witness.parityAfter??null},
  fenceHeld:!any(/^fence_lost:/),
  leaseLost:any(/^lease_(lost|foreign):/),
  probeComplete:!any(/^probe_incomplete:/)&&!any(/^(manifest|derived)_invalid:/),
 };
 return {reasons:[...new Set(reasons)],evidence};
}

export async function readOwnerFacts(binding){
 const rows=(await binding.prepare(OWNER_FACTS_SQL).all()).results;
 if(!Array.isArray(rows)||rows.length>OWNER_FACTS_CAP)throw new CaptureError('owner_facts_unreadable');
 return {count:rows.length,digest:sha(stable(rows.map(row=>[row.kind,row.source_key,row.payload_json,row.generation])))};
}
const reasonOf=(error,fallback)=>error instanceof CaptureError?error.reason:fallback;
const refused=(reasons,run=null)=>({ok:false,verified:false,reasons,run});

// client: an R2 read-only client; db: a D1 binding. For a real run both come from openProductionSource. Result: {ok, verified, reasons, ledger?, gate?, report?, run}.
// A ledger exists ONLY when every check of deriveEvidence held; `verified` is then decided by the transport alone. There is no `verified`, `waivers`, `evidence`
// or `source` argument: the waiver is the pinned one and everything else is observed.
export async function runCutoverMinimum({client,db,leaseId,asOf,exceptions=[],personExceptions=[],now=()=>new Date().toISOString(),expectedSchema,hooks={}}={}){
 if(typeof leaseId!=='string'||!leaseId||typeof asOf!=='string'||!Number.isFinite(Date.parse(asOf)))return refused(['run_invalid']);
 const binding=readOnlyBinding(db);
 const run={version:RUN_VERSION,leaseId,gates:{},witness:{},ownerFacts:{}};
 try{run.ownerFacts.before=await readOwnerFacts(binding);}catch(error){return refused([reasonOf(error,'owner_facts_unreadable')],run);}
 // 1. the narrow capture (GET and HEAD of allowlisted keys, read-only SELECTs)
 const cap=await captureProjectorInputs({client,db,now,...(expectedSchema===undefined?{}:{expectedSchema}),hooks:hooks.capture||{}});
 if(!cap.ok)return refused(cap.reasons.map(item=>'capture:'+item),run);
 const manifest=cap.manifest;
 run.manifest=manifest;
 run.manifestProblems=verifyManifest(manifest,cap.bodies);
 run.derivedProblems=verifyDerived(manifest,cap.derivedValues);
 run.gates.captureBefore=manifest.d1.before;run.gates.captureAfter=manifest.d1.after;
 run.witness.captureBefore=manifest.witness.before;run.witness.captureAfter=manifest.witness.after;
 if(run.manifestProblems.length||run.derivedProblems.length)return refused(deriveEvidence(run).reasons,run);
 // 2. the D1 gate and the witness before the cut; then the expected side from the projector's own view
 try{run.gates.parityBefore=await readCaptureGate(binding,{now});run.witness.parityBefore=await readWitness(readerOf(binding));}catch(error){return refused(['gate_unreadable_before_cut'],run);}
 let classes;
 try{const built=buildExpected({manifest,bodies:cap.bodies,derivedValues:cap.derivedValues,asOf});classes=expectedFromInputs(built.inputs,extraClasses({...built,asOf}));}
 catch(error){return refused([reasonOf(error,'view_failed')],run);}
 if(hooks.beforeCut)await hooks.beforeCut();
 // 3. the stage A stable cut: the ONE D1 write of the run (the projector lease row, released in its finally)
 const cut=await readStableCut(readerOf(db),{leaseId,now});
 run.cut={done:cut.done===true,consistent:cut.consistent===true,reasons:cut.reasons,unavailable:cut.unavailable??null,pages:cut.pages,leaseBefore:cut.gateBefore?.lease??null,leaseAfter:cut.gateAfter?.lease??null};
 if(hooks.afterCut)await hooks.afterCut();
 // 4. after the cut: the gate, every ETag by HEAD, the witness and the owner facts
 try{run.gates.parityAfter=await readCaptureGate(binding,{now});}catch(error){return refused(['gate_unreadable_after_cut'],run);}
 const limited=limitedClient(client,()=>manifest.runId);
 run.etagsAfterCut=[];
 for(const entry of manifest.objects){
  let current;
  try{current=await limited.head(entry.key);}catch{run.etagsAfterCut.push({key:entry.key,error:true});continue;}
  run.etagsAfterCut.push(current?{key:entry.key,state:'present',etag:current.etag}:{key:entry.key,state:'absent',etag:null});
 }
 try{run.witness.parityAfter=await readWitness(readerOf(binding));run.ownerFacts.after=await readOwnerFacts(binding);}catch(error){return refused(['witness_unreadable_after_cut'],run);}
 // 5. the verdict on the run itself: any reason refuses it and NO ledger is built
 const {reasons,evidence}=deriveEvidence(run);
 if(reasons.length)return refused(reasons,run);
 // 6. the transport decides `verified`
 const transport=await transportReasons(client,db);
 const verified=transport.length===0;
 const gateAfter=run.gates.parityAfter;
 const context=contextFromActual({classes:cut.entries},{air286:cut.air286.verified,personExceptions});
 const {ledger}=await buildCutoverMinimumLedger({
  expected:{classes,unavailable:['ownerLink'],complete:true},
  actual:{classes:cut.entries,unavailable:cut.unavailable,consistent:true,complete:true},
  exceptions,context,
  source:{aggregateSha256:manifest.digest,verified,kind:'projector-input-capture'},
  ownerLink:{authority:{mode:gateAfter.owner.mode,generation:gateAfter.owner.generation},factsBefore:run.ownerFacts.before,factsAfter:run.ownerFacts.after},
  evidence,
  waivers:[{...OWNER_LINK_WAIVER}],
 });
 const gate=await cutoverMinimumGate(ledger);
 // counts and digests only: never an id, a title, a name or a payload
 const coverage=Object.fromEntries(Object.entries(ledger.classes).map(([name,entry])=>[name,entry.unavailable?{unavailable:true}:{expected:entry.expected.count,actual:entry.actual.count,missing:entry.missing,extra:entry.extra,differs:entry.differs,explained:entry.explained.total,unexplained:entry.unexplained.total}]));
 const core={runVersion:RUN_VERSION,gate:CUTOVER_MINIMUM_GATE,gateVersion:CUTOVER_MINIMUM_VERSION,measurement:true,authorizes:'nothing',verified,verificationReasons:transport,manifestDigest:manifest.digest,ledgerDigest:ledger.digest,cutoverDigest:ledger.cutoverDigest,asOf,gatePass:gate.pass,gateReasons:gate.reasons,notProved:gate.notProved,totals:ledger.totals,coverage};
 return {ok:true,verified,reasons:transport,ledger,gate,report:{...core,digest:sha(stable(core))},run};
}
