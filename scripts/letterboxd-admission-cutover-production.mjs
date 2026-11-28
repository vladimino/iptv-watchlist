#!/usr/bin/env node
// Owner-only production operator for the Letterboxd admission cutover of card A2 (AIR-608; ADR 0207 decision 1 and 7, ADR 0222). It wraps the delivered mechanism (`src/letterboxd-admission-documents-import.js`: inventory,
// planImport, importDocuments, verifyParity, rollbackImport) and the marker `letterboxd_admission_authority` (r2 -> closed -> d1, closed -> r2), and adds the gates the accepted ADRs require that the import mechanism does
// not own: the ORIGINAL admission freeze gate (verified-films.json against film_rated_admission, scripts/letterboxd-admission-freeze-audit.mjs), the real Diary check queue, the real C2 activation and an exact manifest
// fence. It is NOT run by a deploy, a test or a Task. Default is read-only `status`. Every write needs `--target iptv`, `--confirm <command>`, the pins named below and the owner's L3 GO for exactly that step.
//
//   status           read-only: bytes digests, schema, marker, authorities, the freeze audit (R2 object ETag/size, fingerprints, P1-P5 and P7), the Diary queue, C2, pending facts, the frozen import cohort
//   parity           read-only: the same plus the R2 snapshot against D1 byte for byte (verifyParity) and the exact stored manifest
//   close            r2 G -> closed G+1       pins: generation, admission freeze pin, bytes. The freeze audit must be clean and equal the pin; its D1 side is re-asserted in the batch
//   import           closed G (no marker move)  pins: generation, manifest digest, admission freeze pin, bytes. NO-GO unless every blocker is clear; every batch asserts closed at the pinned generation; the exact manifest is read back
//   flip             closed G -> d1 G+1       pins: generation, manifest digest, admission pin, bytes, C2 control revision, C2 scope revision. Rechecks everything immediately before one fenced batch; IRREVERSIBLE
//   reopen           closed G -> r2 G+1       pins: generation, bytes. Refused while any D1 copy of the moved documents exists: the rollback is verified from D1, not from the marker
//   rollback-import  r2 or closed G (before the flip)  pins: generation, bytes. rollbackImport under a pinned marker, then a readback that no moved document and no manifest remains
//
// No retry of a write, no repair, no delta: a refused or uncertain write ends in a readback and a STOP. The D1 reads of the production path are strict (a response without a result array is an error, never an empty
// result) and are NOT retried either (`retries: 0`). Never calls Letterboxd, the Worker or the API. No document text, film name, code or rating is ever printed: counts, reasons, digests and generations only.
import {createHash,webcrypto} from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import {pathToFileURL} from 'node:url';
import {createD1Adapter,D1Error} from './d1-backfill.mjs';
import {createPublishedBinding,normalize,OperatorStop,PRODUCTION_ACCOUNT_ID,PRODUCTION_DATABASE_ID,PRODUCTION_DATABASE_NAME,productionTarget,readBookmark,trackProductionWrites} from './published-epg-production.mjs';
import {strictBinding} from './catalog-enrichment-activation-production.mjs';
import {createS3Store} from './r2-s3-store.mjs';
import {readCredentials} from './r2-snapshot-export.mjs';
import {FreezeStop,HEALTHY_SQL,readFreeze,readRatingsDocument,REGISTRY_KEY,ROW_SQL} from './letterboxd-admission-freeze-audit.mjs';
import {RATED_RECEIPT_KEY} from '../src/film-admission.js';
import {inventory,MANIFEST_KEY,planImport,importDocuments,rollbackImport,verifyParity} from '../src/letterboxd-admission-documents-import.js';
import {scoped} from './bundle-scope.mjs';
import * as RatingsD1 from '../src/ratings-d1.js';
import * as LetterboxdAdmissionAuthority from '../src/letterboxd-admission-authority.js';
import {ACTIVATION_SCOPE,activeConfigurationReasons,cutoffProblems} from '../src/catalog-enrichment-activation.js';
import {H1_RULES} from '../src/domain/letterboxd-lid-only-proof.js';

const {readAdmissionAuthority}=LetterboxdAdmissionAuthority;
// The production readers (`src/letterboxd-admission-documents.js`) are Worker-scope code: they run here in the same scope the Worker bundle gives them (the way the A1 tests load them), so the manifest is proven by
// the reader's OWN contract (`requireManifest`), not by a copy of it.
let documents=null;
function documentReaders(){
 if(!documents){
  const context=vm.createContext({RatingsD1,LetterboxdAdmissionAuthority,JSON,Object,Number,Promise,Error,Date,Map,Set,structuredClone,TextEncoder,Uint8Array,crypto:webcrypto});
  vm.runInContext(scoped('src/letterboxd-admission-documents.js','LetterboxdAdmissionDocuments'),context);
  documents=vm.runInContext('LetterboxdAdmissionDocuments',context);
 }
 return documents;
}
export const COMMANDS=['status','parity','close','import','flip','reopen','rollback-import'];
const WRITES=['close','import','flip','reopen','rollback-import'];
const NEEDS={
 close:['generation','admissionSha256','bytesSha256'],
 import:['generation','manifestSha256','admissionSha256','bytesSha256'],
 flip:['generation','manifestSha256','admissionSha256','bytesSha256','controlRevision','scopeRevision'],
 reopen:['generation','bytesSha256'],
 'rollback-import':['generation','bytesSha256'],
};
const VALUE_FLAGS={'--target':'target','--confirm':'confirm','--expect-generation':'generation','--expect-manifest-sha256':'manifestSha256','--expect-admission-sha256':'admissionSha256','--expect-bytes-sha256':'bytesSha256','--expect-control-revision':'controlRevision','--expect-scope-revision':'scopeRevision'};
// The authoritative shared Diary check queue (ADR 0221): `{films:{<lid>:entry}, backlog:{<lid>:record}}`. NOT `letterboxd/diary/state.json` (the Diary viewing/history cursor).
export const DIARY_QUEUE_KEY='letterboxd/facts/scans/diary-identity.json';
const LINK_REASONS=new Set(['linking','link_failed','lid_only_intent']);
const RECEIPT_ORIGIN='rated_admission_retention';
// The unresolved states of a canonical write receipt (migration 0019, the keyed protocol of ADR 0207 / migration 0039): pending, failed AND unknown. Used by status, import, flip and the flip batch alike. A canonical operation-key
// reservation is this receipt state; an expired source-check reservation inside the Diary queue is a different thing and is counted separately.
const UNRESOLVED="('pending','failed','unknown')";
const MOVED_LIKE="letterboxd/imports/%";

// The bytes that run: this operator and every first-party module it executes. A transitive import of these files that is not listed (the Node runtime, `node:` built-ins) is pinned only by the exact clean commit.
const PINNED_FILES=['scripts/letterboxd-admission-cutover-production.mjs','scripts/letterboxd-admission-freeze-audit.mjs','scripts/catalog-enrichment-activation-production.mjs','scripts/d1-backfill.mjs','scripts/published-epg-production.mjs','scripts/r2-s3-store.mjs','scripts/r2-snapshot-export.mjs','scripts/bundle-scope.mjs',
 'src/letterboxd-admission-documents-import.js','src/letterboxd-admission-documents.js','src/letterboxd-admission-authority.js','src/ratings-d1.js','src/film-admission.js','src/catalog-enrichment-activation.js','src/domain/letterboxd-lid-only-proof.js'];
export function bytesDigest(){
 const list=PINNED_FILES.map(file=>[file,createHash('sha256').update(fs.readFileSync(new URL('../'+file,import.meta.url))).digest('hex')]);
 return {sha256:createHash('sha256').update(JSON.stringify(list)).digest('hex'),files:list.length,operator:list[0][1]};
}

async function one(binding,sql,params=[]){return (await many(binding,sql,params))[0]??null;}
async function many(binding,sql,params=[]){
 const result=await binding.prepare(sql).bind(...params).all();
 if(!result||!Array.isArray(result.results))throw new OperatorStop('unknown_state',3,{reason:'read_malformed'});
 return result.results;
}

// ---- pure: what the frozen R2 cohort says is still in flight (a NO-GO under `closed`; nothing is repaired) -----------------------------------
export function pendingInR2(plan){
 let admitting=0,withoutReceipt=0;
 const keys=new Set(plan.documents.map(item=>item.key));
 for(const item of plan.documents){
  if(item.key.endsWith('/rated-candidates.json')){
   const candidates=item.value&&typeof item.value.candidates==='object'&&item.value.candidates?Object.values(item.value.candidates):[];
   for(const row of candidates)if(row&&row.state==='admitting')admitting++;
  }
  if(item.key.endsWith('.intent.json')&&!keys.has(item.key.replace(/\.intent\.json$/,'.receipt.json')))withoutReceipt++;
 }
 return {admittingCandidates:admitting,chunksWithoutReceipt:withoutReceipt,documents:plan.documents.length};
}
// Pure. The Diary check queue of ADR 0221. An ABSENT document is an empty queue (positive absence: the read succeeded and found no part). A present document must have object `films` and (when present) object `backlog`
// whose entries are objects; anything else is malformed and FAILS CLOSED, never counts as zero. -> {state, films, backlog, linkIntents, reservations, claimPending}
export function diaryQueueState(doc){
 if(doc===null||doc===undefined)return {state:'absent',films:0,backlog:0,linkIntents:0,reservations:0,claimPending:0};
 const value=doc.value;
 const object=item=>item!==null&&typeof item==='object'&&!Array.isArray(item);
 if(!object(value))throw new OperatorStop('diary_queue_malformed',3,{reason:'not_an_object'});
 if(value.films!==undefined&&!object(value.films))throw new OperatorStop('diary_queue_malformed',3,{reason:'films'});
 if(value.backlog!==undefined&&!object(value.backlog))throw new OperatorStop('diary_queue_malformed',3,{reason:'backlog'});
 const films=value.films||{},backlog=value.backlog||{};
 let linkIntents=0,reservations=0,claimPending=0;
 for(const entry of Object.values(films)){
  if(!object(entry))throw new OperatorStop('diary_queue_malformed',3,{reason:'entry'});
  if(typeof entry.reason==='string'&&LINK_REASONS.has(entry.reason))linkIntents++;
  if(entry.reason==='claim_pending')claimPending++;
  // any reservation (active or expired) is an old-key reservation that was never settled: unresolved
  if(entry.reservation!==undefined&&entry.reservation!==null)reservations++;
 }
 for(const record of Object.values(backlog))if(!object(record))throw new OperatorStop('diary_queue_malformed',3,{reason:'backlog_entry'});
 return {state:'present',films:Object.keys(films).length,backlog:Object.keys(backlog).length,linkIntents,reservations,claimPending};
}

// ---- state (read only) ------------------------------------------------------------------------------------------------
export async function readState(binding){
 const env={DB:binding};
 try{
  const schema=await one(binding,'SELECT version FROM schema_contract WHERE id=1');
  const authority=await readAdmissionAuthority(env);
  const activated=authority.installed?(await one(binding,'SELECT activated_at FROM letterboxd_admission_authority WHERE id=1'))?.activated_at??null:null;
  const ratings=await one(binding,'SELECT mode, cutover, generation FROM ratings_domain_authority WHERE id=1');
  const filmPerson=await one(binding,'SELECT mode, cutover, generation FROM film_person_authority WHERE id=1');
  const receipts=await one(binding,'SELECT COUNT(*) AS n FROM canonical_write_receipt WHERE origin=? AND state IN '+UNRESOLVED,[RECEIPT_ORIGIN]);
  const scopes=await many(binding,'SELECT scope, activated, enabled, cutoff_at, bootstrap_state, revision FROM catalog_enrichment_scope ORDER BY scope');
  const control=await one(binding,'SELECT state, generation, revision FROM catalog_enrichment_control WHERE id=1');
  const diary=await readRatingsDocument(binding,DIARY_QUEUE_KEY);
  const moved=await many(binding,"SELECT key, COUNT(*) AS parts, MIN(etag) AS etag, MAX(etag) AS etag2 FROM ratings_document WHERE key LIKE ? GROUP BY key ORDER BY key",[MOVED_LIKE]);
  return {
   version:schema?Number(schema.version):null,
   marker:{mode:authority.mode,generation:authority.generation,installed:authority.installed,activatedAt:activated},
   ratings:ratings?{mode:ratings.mode,cutover:ratings.cutover,generation:Number(ratings.generation)}:null,
   filmPerson:filmPerson?{mode:filmPerson.mode,cutover:filmPerson.cutover}:null,
   openReceipts:receipts?Number(receipts.n):null,
   diary:{...diaryQueueState(diary),etag:diary?diary.etag:null},
   scopes:scopes.map(row=>({scope:row.scope,activated:Number(row.activated),enabled:Number(row.enabled),cutoffAt:row.cutoff_at,bootstrap:row.bootstrap_state,revision:Number(row.revision)})),
   control:control?{state:control.state,generation:Number(control.generation),revision:Number(control.revision)}:null,
   moved:moved.map(row=>({key:row.key,parts:Number(row.parts),etag:row.etag===row.etag2?row.etag:null})),
   h1RulesEmpty:H1_RULES.eligibleTypes.length===0&&H1_RULES.idBlockMarker===null,
  };
 }catch(error){
  if(error instanceof OperatorStop)throw error;
  if(error instanceof FreezeStop)throw new OperatorStop('unknown_state',3,{reason:error.reason});
  throw new OperatorStop('unknown_state',3,{reason:error&&error.code?String(error.code):'read_failed'});
 }
}
const view=state=>({schema:state.version,marker:state.marker,ratings:state.ratings,filmPerson:state.filmPerson});

// C2 activation (card A2 prerequisite, ADR 0207 decision 1): the control is ACTIVE, exactly the rated scope is enabled and activated with a done bootstrap, and its approved cutoff is not later than the flip.
// Film/Person and Ratings are open (an unrelated Ratings generation bump is allowed, a lost authority is not). -> the problems; empty = active.
export function c2Problems(state,flipIso){
 const problems=[];
 if(!state.control||state.control.state!=='active')problems.push('c2_control_not_active');
 const rows=state.scopes.map(row=>({scope:row.scope,activated:row.activated,enabled:row.enabled,cutoff_at:row.cutoffAt,bootstrap_state:row.bootstrap}));
 for(const reason of activeConfigurationReasons(rows,null))problems.push('c2_'+reason);
 const rated=state.scopes.find(row=>row.scope===ACTIVATION_SCOPE);
 if(rated)for(const reason of cutoffProblems(rated.cutoffAt,flipIso))problems.push('c2_'+reason);
 if(!state.filmPerson||state.filmPerson.mode!=='d1'||state.filmPerson.cutover!=='open')problems.push('film_person_not_open');
 if(!state.ratings||state.ratings.mode!=='d1'||state.ratings.cutover!=='open')problems.push('ratings_not_open');
 return problems;
}

// The planner of the frozen cohort: inventory (R2 read only), then planImport.
export async function frozenPlan(bucket){
 const snapshot=await inventory(bucket);
 const plan=planImport(snapshot);
 return {plan,pending:plan.manifest?pendingInR2(plan):null};
}
export const blockers=({plan,pending},state,freeze)=>{
 const out=[];
 if(plan.blocked.length)out.push('plan_blocked');
 if(pending&&pending.admittingCandidates>0)out.push('admitting_candidates');
 if(pending&&pending.chunksWithoutReceipt>0)out.push('chunk_intent_without_receipt');
 if(state.openReceipts!==0)out.push('open_receipts');
 if(state.diary.linkIntents>0)out.push('diary_link_intents');
 if(state.diary.reservations>0)out.push('diary_reservations');
 if(freeze)for(const problem of freeze.problems)out.push('admission_'+problem);
 return out;
};
const planView=({plan,pending})=>({blocked:plan.blocked.map(item=>({reason:item.reason})),documents:plan.documents.length,manifestSha256:plan.manifestSha256,inventorySha256:plan.manifest?plan.manifest.inventorySha256:null,pending});
const freezeView=freeze=>({pin:freeze.pin,object:freeze.object,registry:freeze.registry,d1:freeze.d1,counts:freeze.counts,problems:freeze.problems,r2Fingerprint:freeze.r2Fingerprint,d1Fingerprint:freeze.d1Fingerprint});
async function freezeOf(binding,bucket){
 try{return await readFreeze({binding,store:bucket});}
 catch(error){if(error instanceof FreezeStop)throw new OperatorStop('freeze_'+error.reason,3,error.details);throw error;}
}

// ---- the fenced statements ------------------------------------------------------------------------------------------------
const assertSql=(sql,params=[])=>['UPDATE ratings_domain_cas SET ok=CASE WHEN '+sql+' THEN 1 ELSE 0 END WHERE id=1',params];
// The guard row `ratings_domain_cas` id=1 EXISTS (an UPDATE of a missing row would otherwise pass every assertion); first statement of EVERY fenced batch, helper batches included.
// An INSERT that trips the CHECK (ok >= 1) exactly when the row is absent; with the row present it inserts nothing.
const GUARD_PRESENT=['INSERT INTO ratings_domain_cas (id,ok) SELECT 1,0 WHERE NOT EXISTS (SELECT 1 FROM ratings_domain_cas WHERE id=1)',[]];
const ONE_ROW_CHANGED=['UPDATE ratings_domain_cas SET ok=CASE WHEN changes()=1 THEN 1 ELSE 0 END WHERE id=1',[]];

// ---- pinned binding: every batch of a helper (import, rollback) starts with the guard-row existence check and an assertion of the marker at the PINNED generation, so a close/reopen/close between the caller's pin
// and the helper's own fresh read refuses whole, and a missing CAS row cannot turn the assertion into a no-op ----
export function pinnedBinding(binding,{modes,generation}){
 return {...binding,async batch(statements){
  const present=binding.prepare(GUARD_PRESENT[0]).bind();
  const assertion=binding.prepare(assertSql('EXISTS (SELECT 1 FROM letterboxd_admission_authority WHERE id=1 AND mode IN ('+modes.map(()=>'?').join(',')+') AND generation=?)')[0]).bind(...modes,generation);
  return binding.batch([present,assertion,...statements]);
 }};
}

// The D1 side of the admission freeze, EXACTLY as observed (not a count or watermark surrogate), fenced in the batch:
//  - the exact admission rows (every column of P3 plus the Film id and receipt key), in 40-row slices, and the row count;
//  - the P7 health of every row (the Film, its redirect state and its tmdb external-id rows), as one count over the same predicate;
//  - the versions (etags, or absence) of the Ratings documents P4/P5 read: the link index and each fact record, and (when given) the Diary check queue.
// Unrelated metadata updates (a title, a timestamp the audit does not read) are NOT fenced.
export function freezeAssertions(freeze,{diary}={}){
 const out=[assertSql('(SELECT COUNT(*) FROM film_rated_admission)=?',[freeze.fence.rows.length])];
 for(let index=0;index<freeze.fence.rows.length;index+=40){
  const slice=freeze.fence.rows.slice(index,index+40);
  out.push(assertSql('(SELECT COUNT(*) FROM film_rated_admission WHERE ('+ROW_SQL+') IN ('+slice.map(()=>'?').join(',')+'))=?',[...slice,slice.length]));
 }
 // the invariant is ALL rows healthy (the audit refuses anything else), so the batch asserts the healthy count equals the number of rows, not a sampled count
 out.push(assertSql('(SELECT COUNT(*) FROM film_rated_admission a WHERE '+HEALTHY_SQL+')=?',[freeze.fence.rows.length]));
 const versions=[...freeze.fence.documents,...(diary?[{key:DIARY_QUEUE_KEY,etag:diary.etag}]:[])];
 for(let index=0;index<versions.length;index+=40){
  const slice=versions.slice(index,index+40);
  const present=slice.filter(item=>item.etag!==null),absent=slice.filter(item=>item.etag===null);
  if(present.length)out.push(assertSql('(SELECT COUNT(*) FROM ratings_document WHERE part=0 AND ('+present.map(()=>'(key=? AND etag=?)').join(' OR ')+'))=?',[...present.flatMap(item=>[item.key,item.etag]),present.length]));
  if(absent.length)out.push(assertSql('NOT EXISTS (SELECT 1 FROM ratings_document WHERE key IN ('+absent.map(()=>'?').join(',')+'))',absent.map(item=>item.key)));
 }
 return out;
}
// The observed moved documents (key, etag, part count) and the manifest, fenced in 40-key slices. Exact set: nothing more and nothing less under the prefix.
export function documentFence(moved){
 const out=[assertSql('(SELECT COUNT(DISTINCT key) FROM ratings_document WHERE key LIKE ?)=?',[MOVED_LIKE,moved.length]),assertSql('(SELECT COUNT(*) FROM ratings_document WHERE key LIKE ?)=?',[MOVED_LIKE,moved.reduce((sum,item)=>sum+item.parts,0)])];
 for(let index=0;index<moved.length;index+=40){
  const slice=moved.slice(index,index+40);
  out.push(assertSql('(SELECT COUNT(*) FROM ratings_document WHERE part=0 AND ('+slice.map(()=>'(key=? AND etag=?)').join(' OR ')+'))=?',[...slice.flatMap(item=>[item.key,item.etag]),slice.length]));
 }
 return out;
}
const TRANSITIONS={
 close:{from:'r2',to:'closed'},
 reopen:{from:'closed',to:'r2'},
};
export function transitionStatements(command,{generation,extra=[]}){
 const spec=TRANSITIONS[command];
 if(!spec)throw new OperatorStop('usage',2);
 return {target:{mode:spec.to,generation:generation+1},statements:[
  GUARD_PRESENT,
  assertSql("EXISTS (SELECT 1 FROM letterboxd_admission_authority WHERE id=1 AND mode=? AND generation=?)",[spec.from,generation]),
  ...extra,
  ['UPDATE letterboxd_admission_authority SET mode=?, generation=? WHERE id=1 AND mode=? AND generation=?',[spec.to,generation+1,spec.from,generation]],
  ONE_ROW_CHANGED,
 ]};
}
// The reopen is fenced on the ABSENCE of every moved document and the manifest in the same batch: a competing import in the same closed generation refuses it.
export const noMovedDocuments=()=>[assertSql('NOT EXISTS (SELECT 1 FROM ratings_document WHERE key LIKE ?)',[MOVED_LIKE])];
export function flipStatements({generation,activatedAt,freeze,moved,control,scope,diary}){
 return {
  target:{mode:'d1',generation:generation+1},
  statements:[
   GUARD_PRESENT,
   assertSql("EXISTS (SELECT 1 FROM letterboxd_admission_authority WHERE id=1 AND mode='closed' AND generation=?)",[generation]),
   ...freezeAssertions(freeze,{diary}),
   ...documentFence(moved),
   assertSql('NOT EXISTS (SELECT 1 FROM canonical_write_receipt WHERE origin=? AND state IN '+UNRESOLVED+')',[RECEIPT_ORIGIN]),
   assertSql("EXISTS (SELECT 1 FROM catalog_enrichment_control WHERE id=1 AND state='active' AND revision=?)",[control.revision]),
   assertSql("(SELECT COUNT(*) FROM catalog_enrichment_scope)=1 AND EXISTS (SELECT 1 FROM catalog_enrichment_scope WHERE scope='rated' AND activated=1 AND enabled=1 AND bootstrap_state='done' AND cutoff_at=? AND revision=?)",[scope.cutoffAt,scope.revision]),
   assertSql("EXISTS (SELECT 1 FROM film_person_authority WHERE id=1 AND mode='d1' AND cutover='open') AND EXISTS (SELECT 1 FROM ratings_domain_authority WHERE id=1 AND mode='d1' AND cutover='open')",[]),
   ["UPDATE letterboxd_admission_authority SET mode='d1', generation=?, activated_at=? WHERE id=1 AND mode='closed' AND generation=?",[generation+1,activatedAt,generation]],
   ONE_ROW_CHANGED,
  ],
 };
}

async function applyBatch(binding,plan,ctx,{unchangedState,activatedAt=undefined}){
 if(ctx.track)ctx.track('unknown');
 let failure=null;
 try{await binding.batch(plan.statements.map(([sql,params])=>binding.prepare(sql).bind(...params)));}catch(error){failure=error;}
 // an ACKNOWLEDGED atomic batch is a confirmed effect (the production tracker keeps it as `committed` too), whatever the readback says afterwards
 if(!failure&&ctx.track)ctx.track('committed');
 let after=null;
 try{after=await readState(binding);}catch{after=null;}
 const reached=Boolean(after)&&after.marker.mode===plan.target.mode&&after.marker.generation===plan.target.generation&&(activatedAt===undefined||after.marker.activatedAt===activatedAt);
 const unchanged=Boolean(after)&&after.marker.mode===unchangedState.mode&&after.marker.generation===unchangedState.generation;
 if(failure){
  // Only a PROVEN statement rejection with the marker untouched is "not applied"; anything else stays unproven and is never downgraded by a readback.
  const rejected=failure instanceof D1Error?failure.kind==='statement'&&unchanged:/CHECK constraint failed/i.test(String(failure&&failure.message))&&unchanged;
  if(ctx.track)ctx.track(rejected?'none':'unknown');
  throw new OperatorStop(rejected?'predicate_refused':'write_uncertain',3,{marker:after?after.marker:null,...(reached?{reachedByUnknownOutcome:true}:{})});
 }
 // acknowledged, but the immediate readback is unavailable: committed but UNVERIFIED. The confirmed effect and the expected marker are preserved and the observed marker is explicitly unknown; no retry, no repair.
 if(!after)throw new OperatorStop('committed_unverified',3,{committed:true,irreversible:plan.target.mode==='d1',expectedMarker:{...plan.target,...(activatedAt!==undefined?{activatedAt}:{})},observedMarker:null,readback:'unavailable',note:'the atomic batch was acknowledged; verify by reading, never retry'});
 if(!reached){if(ctx.track)ctx.track('unknown');throw new OperatorStop('write_uncertain',3,{reason:'readback_mismatch',marker:after.marker});}
 return after;
}

// verifyParity throws on a document that cannot be read (a damaged part, an unavailable domain): a STOP with its own reason, never a silent `equal`.
async function parityOf(binding,plan,bucket){
 try{return await verifyParity({DB:binding},plan,bucket);}
 catch(error){throw new OperatorStop('parity_unreadable',3,{reason:error&&error.code?String(error.code):'read_failed'});}
}
// The stored manifest must EQUAL the approved canonical manifest and satisfy the production reader's contract (`requireManifest`). The reasons separate a PROVEN violation (a damaged document, a different manifest, a
// contract error of the reader) from an UNREADABLE one (a transport or response failure, which proves nothing about the manifest).
async function exactManifest(binding,plan){
 let stored;
 try{stored=await readRatingsDocument(binding,MANIFEST_KEY);}
 catch(error){throw error instanceof FreezeStop&&error.reason==='document_unreadable'?new OperatorStop('manifest_damaged',3,{kind:error.details&&error.details.kind}):new OperatorStop('manifest_unreadable',3);}
 if(!stored||JSON.stringify(stored.value)!==JSON.stringify(plan.manifest))throw new OperatorStop('manifest_not_exact',3);
 try{await documentReaders().validateStoredManifest({DB:binding});}
 catch(error){
  const code=error&&error.code?String(error.code):'';
  if(/^admission_documents_/.test(code)&&code!=='admission_documents_unavailable')throw new OperatorStop('manifest_contract',3,{reason:code});
  throw new OperatorStop('manifest_unreadable',3);
 }
}
const movedCopies=state=>state.moved.length;

// ---- commands ---------------------------------------------------------------------------------------------------------
const noGo=(reason,details)=>new OperatorStop(reason,3,details);
// A parity report for status/parity: the exact stored manifest (the production reader's contract) is part of it, not only the importer's weaker comparison.
async function manifestVerdict(binding,plan){
 try{await exactManifest(binding,plan);return {ok:true};}
 catch(error){return {ok:false,reason:error instanceof OperatorStop?error.reason:'manifest_check_failed'};}
}
export async function execute(command,{binding,bucket,args={},now=()=>Date.now(),ctx={}}){
 const state=await readState(binding);
 const m=state.marker;
 if(state.version===null||state.version<46||!m.installed)throw new OperatorStop('marker_not_installed',3);
 const bytes=bytesDigest();
 if(command==='status'||command==='parity'){
  const out={operation:command,writes:false,writeState:'none',bytes,state:view(state),
   diary:state.diary,pending:{openReceipts:state.openReceipts},
   c2:{problems:c2Problems(state,new Date(now()).toISOString()),control:state.control,scope:state.scopes.find(item=>item.scope===ACTIVATION_SCOPE)??null,scopes:state.scopes.length},
   h1RulesEmpty:state.h1RulesEmpty,d1Copies:{documents:movedCopies(state)}};
  if(!bucket){if(command==='parity')throw new OperatorStop('configuration',2);return out;}
  const frozen=await frozenPlan(bucket),freeze=await freezeOf(binding,bucket);
  out.r2=planView(frozen);out.freeze=freezeView(freeze);out.blockers=blockers(frozen,state,freeze);
  if(command==='status')return out;
  // parity is an UNAMBIGUOUS go / no-go: no blocker, the R2 snapshot equal to D1 byte for byte, and the stored manifest exactly the approved one under the production reader's contract
  if(!frozen.plan.manifest)throw noGo('no_go',{...out,go:false,reasons:['plan_blocked']});
  const parity=await parityOf(binding,frozen.plan,bucket);
  const manifest=await manifestVerdict(binding,frozen.plan);
  out.equal=parity.equal;out.differences=parity.differences.map(item=>({kind:item.kind}));out.exactManifest=manifest;
  const reasons=[...out.blockers,...(parity.equal?[]:['parity_mismatch']),...(manifest.ok?[]:['manifest_'+manifest.reason])];
  // `dataParityGo` is the DATA verdict only (blockers, byte parity, exact manifest). `go` also requires the activation prerequisites the flip itself enforces: the marker `closed`, an active C2, open authorities and
  // empty H1 rules, so a clean copy is never read as readiness.
  out.dataParityGo=reasons.length===0;
  const readiness=[...(m.mode==='closed'?[]:['marker_not_closed']),...out.c2.problems,...(state.h1RulesEmpty?[]:['h1_rules_not_empty'])];
  out.readiness={go:readiness.length===0,reasons:readiness};
  out.go=out.dataParityGo&&out.readiness.go;
  if(!out.go)throw noGo('no_go',{...out,reasons:[...reasons,...readiness]});
  return out;
 }
 if(!WRITES.includes(command))throw new OperatorStop('usage',2);
 if(bytes.sha256!==args.bytesSha256)throw new OperatorStop('bytes_pin_mismatch',3,{bytes});
 if(m.generation!==args.generation)throw new OperatorStop('generation_moved',3,{marker:m});
 if(state.ratings?.mode!=='d1'||state.ratings?.cutover!=='open')throw new OperatorStop('ratings_not_open',3,{ratings:state.ratings});
 if(command==='reopen'){
  if(m.mode!=='closed')throw new OperatorStop('marker_not_closed',3,{marker:m});
  if(movedCopies(state)>0)throw new OperatorStop('d1_copies_present',3,{documents:movedCopies(state)});
  const plan=transitionStatements('reopen',{generation:m.generation,extra:noMovedDocuments()});
  const after=await applyBatch(binding,plan,ctx,{unchangedState:m});
  return {operation:'reopen',writes:true,writeState:'committed',before:view(state),marker:plan.target,after:view(after)};
 }
 if(command==='rollback-import'){
  if(m.mode==='d1')throw new OperatorStop('rollback_after_flip',3);
  const pinned=pinnedBinding(binding,{modes:[m.mode],generation:m.generation});
  if(ctx.track)ctx.track('unknown');
  try{await rollbackImport({DB:pinned});}catch(error){throw new OperatorStop('write_uncertain',3,{reason:error&&error.code?String(error.code):'rollback_failed'});}
  const after=await readState(binding);
  // the rollback is judged by what REMAINS in D1, never by the marker
  if(movedCopies(after)!==0||after.marker.mode!==m.mode||after.marker.generation!==m.generation)throw new OperatorStop('write_uncertain',3,{reason:'rollback_not_verified',remaining:movedCopies(after),marker:after.marker});
  if(ctx.track)ctx.track('committed');
  return {operation:command,writes:true,writeState:'committed',before:view(state),after:view(after),d1Copies:{documents:0}};
 }
 // close, import and flip read the original admission freeze (R2 object + D1 rows)
 if(!bucket)throw new OperatorStop('configuration',2);
 const freeze=await freezeOf(binding,bucket);
 if(freeze.problems.length)throw noGo('no_go',{blockers:freeze.problems.map(problem=>'admission_'+problem),freeze:freezeView(freeze)});
 if(freeze.pin!==args.admissionSha256)throw new OperatorStop('admission_pin_mismatch',3,{freeze:freezeView(freeze)});
 if(command==='close'){
  if(m.mode!=='r2')throw new OperatorStop('marker_not_r2',3,{marker:m});
  const plan=transitionStatements('close',{generation:m.generation,extra:freezeAssertions(freeze)});
  const after=await applyBatch(binding,plan,ctx,{unchangedState:m});
  return {operation:'close',writes:true,writeState:'committed',before:view(state),marker:plan.target,after:view(after),freeze:freezeView(freeze)};
 }
 // import and flip need the frozen cohort and its digest pin, under `closed`
 if(m.mode!=='closed')throw new OperatorStop('marker_not_closed',3,{marker:m});
 const frozen=await frozenPlan(bucket);
 const stops=blockers(frozen,state,freeze);
 if(!frozen.plan.manifest||stops.length)throw noGo('no_go',{blockers:stops,r2:planView(frozen)});
 if(frozen.plan.manifestSha256!==args.manifestSha256)throw new OperatorStop('manifest_pin_mismatch',3,{r2:planView(frozen)});
 if(command==='import'){
  const pinned=pinnedBinding(binding,{modes:['closed'],generation:m.generation});
  if(ctx.track)ctx.track('unknown');
  let result;
  try{result=await importDocuments({DB:pinned},frozen.plan);}
  catch(error){throw new OperatorStop(error&&error.code==='diverged'?'diverged':'write_uncertain',3,{reason:error&&error.code?String(error.code):'import_failed'});}
  const after=await readState(binding);
  if(after.marker.mode!=='closed'||after.marker.generation!==m.generation)throw new OperatorStop('write_uncertain',3,{reason:'marker_moved_during_import',marker:after.marker});
  await exactManifest(binding,frozen.plan);
  const parity=await parityOf(binding,frozen.plan,bucket);
  if(!parity.equal)throw new OperatorStop('parity_mismatch',3,{differences:parity.differences.map(item=>({kind:item.kind}))});
  if(ctx.track)ctx.track('committed');
  return {operation:'import',writes:true,writeState:'committed',imported:result.imported,skipped:result.skipped,manifest:result.manifest,manifestExact:true,parity:'equal',r2:planView(frozen),freeze:freezeView(freeze)};
 }
 // flip. The read sequence: C2 and pins, the moved cohort (exact manifest, parity), the whole freeze audit (the object is re-pinned at its END), then the FINAL re-pins of the moved cohort and the admissions
 // object and registry as the LAST reads before the one fenced batch. The R2/D1 gap that remains between those reads and the batch is not atomic (no shared transaction): it is covered by the proven drain and the
 // marker guard every writer reads before its R2 PUT, and the D1 side is fenced inside the batch.
 const flipAt=new Date(now()).toISOString();
 const problems=c2Problems(state,flipAt);
 if(problems.length)throw new OperatorStop('c2_not_active',3,{problems});
 if(!state.h1RulesEmpty)throw new OperatorStop('h1_rules_not_empty',3);
 const rated=state.scopes.find(item=>item.scope===ACTIVATION_SCOPE);
 if(state.control.revision!==args.controlRevision||rated.revision!==args.scopeRevision)throw new OperatorStop('c2_pin_mismatch',3,{control:state.control,scope:{revision:rated.revision,cutoffAt:rated.cutoffAt}});
 await exactManifest(binding,frozen.plan);
 const parity=await parityOf(binding,frozen.plan,bucket);
 if(!parity.equal)throw new OperatorStop('parity_mismatch',3,{differences:parity.differences.map(item=>({kind:item.kind}))});
 const last=await freezeOf(binding,bucket);
 if(last.pin!==args.admissionSha256||last.problems.length)throw new OperatorStop('admission_moved',3,{freeze:freezeView(last)});
 const again=await frozenPlan(bucket);
 if(!again.plan.manifest||again.plan.manifestSha256!==args.manifestSha256)throw new OperatorStop('manifest_moved',3,{r2:planView(again)});
 const repinObject=await bucket.head(RATED_RECEIPT_KEY),repinRegistry=await bucket.head(REGISTRY_KEY);
 if(!repinObject||repinObject.etag!==last.object.etag||(repinObject.size!==undefined&&repinObject.size!==null&&Number.isFinite(Number(repinObject.size))&&Number(repinObject.size)!==last.object.bytes))throw new OperatorStop('admission_moved',3,{reason:'final_repin'});
 if((repinRegistry?repinRegistry.etag:null)!==last.registry.etag)throw new OperatorStop('registry_moved',3);
 const plan=flipStatements({generation:m.generation,activatedAt:flipAt,freeze:last,moved:state.moved,control:state.control,scope:rated,diary:state.diary});
 const after=await applyBatch(binding,plan,ctx,{unchangedState:m,activatedAt:flipAt});
 // The flip is COMMITTED and irreversible from here. Every postcondition is verified and reported field by field. A failed or unproven one is an explicit committed-but-unverified STOP (marker, generation,
 // activated_at, per-field evidence, retry false, no rollback), never a success and never a retryable failure.
 const verified={manifestExact:null,parityEqual:null,admissionObjectUnchanged:null,registryUnchanged:null},unproven=[],violations=[];
 try{await exactManifest(binding,frozen.plan);verified.manifestExact=true;}
 catch(error){
  // a transport failure proves nothing about the manifest: unproven. A damaged document, another manifest or a contract error of the reader is a proven violation.
  if(error instanceof OperatorStop&&error.reason==='manifest_unreadable'){verified.manifestExact=null;unproven.push('manifest_unreadable');}
  else{verified.manifestExact=false;violations.push('manifest_check_failed');}
 }
 try{
  const post=await parityOf(binding,frozen.plan,bucket);
  verified.parityEqual=post.equal;
  if(!post.equal){
   // an R2 drift, a vanished or extra R2 key is a freeze violation; a D1 document that differs from the frozen R2 copy after the flip is legitimate natural D1 traffic and only leaves the comparison unproven
   if(post.differences.some(item=>item.kind==='r2_drift'))violations.push('r2_frozen_moved');
   else unproven.push('d1_moved_after_flip');
  }
 }catch{verified.parityEqual=null;unproven.push('parity_unreadable');}
 try{
  const headObject=await bucket.head(RATED_RECEIPT_KEY),headRegistry=await bucket.head(REGISTRY_KEY);
  verified.admissionObjectUnchanged=Boolean(headObject)&&headObject.etag===last.object.etag&&(headObject.size===undefined||headObject.size===null||!Number.isFinite(Number(headObject.size))||Number(headObject.size)===last.object.bytes);
  verified.registryUnchanged=(headRegistry?headRegistry.etag:null)===last.registry.etag;
  if(!verified.admissionObjectUnchanged)violations.push('admissions_object_moved');
  if(!verified.registryUnchanged)violations.push('registry_moved');
 }catch{unproven.push('r2_unreadable');}
 if(violations.length||unproven.length)throw new OperatorStop('committed_unverified',3,{committed:true,irreversible:true,marker:{mode:after.marker.mode,generation:after.marker.generation,activatedAt:after.marker.activatedAt},verified,violations,unproven,note:'the flip is committed; no rollback and no retry; verify by reading, then roll forward'});
 return {operation:'flip',writes:true,writeState:'committed',before:view(state),marker:plan.target,after:view(after),irreversible:true,verified,r2:planView(frozen),freeze:freezeView(last)};
}

// ---- CLI --------------------------------------------------------------------------------------------------------------
export function parseArgs(argv){
 const args=argv.slice(2),parsed={};
 const commands=args.filter(arg=>arg.startsWith('--')&&COMMANDS.includes(arg.slice(2)));
 if(commands.length>1)throw new OperatorStop('usage',2);
 for(let index=0;index<args.length;index++){
  const arg=args[index];
  if(commands.includes(arg))continue;
  const name=VALUE_FLAGS[arg],next=args[index+1];
  if(!name||next===undefined||next.startsWith('--')||parsed[name]!==undefined)throw new OperatorStop('usage',2);
  parsed[name]=next;index++;
 }
 const command=commands[0]?commands[0].slice(2):'status';
 if(parsed.target===undefined){
  if(command!=='status')throw new OperatorStop('target_required',2);
  return {report:{configured:false,writes:false,writeState:'none'}};
 }
 if(parsed.target!==PRODUCTION_DATABASE_NAME)throw new OperatorStop('target_invalid',2);
 if(!WRITES.includes(command)){if(parsed.confirm!==undefined||Object.keys(parsed).some(key=>key!=='target'))throw new OperatorStop('usage',2);return {command,args:{}};}
 if(parsed.confirm!==command)throw new OperatorStop('confirm',2);
 for(const need of NEEDS[command])if(parsed[need]===undefined)throw new OperatorStop('usage',2);
 const out={};
 for(const key of Object.keys(parsed)){
  if(key==='target'||key==='confirm')continue;
  if(!NEEDS[command].includes(key))throw new OperatorStop('usage',2);
  if(['generation','controlRevision','scopeRevision'].includes(key)){if(!/^\d{1,9}$/.test(parsed[key]))throw new OperatorStop('usage',2);out[key]=Number(parsed[key]);}
  else{if(!/^[0-9a-f]{64}$/.test(parsed[key]))throw new OperatorStop('usage',2);out[key]=parsed[key];}
 }
 return {command,args:out};
}

function readStoreOf(env,fetchImpl){
 let credentials;
 try{credentials=readCredentials(env);}catch(error){throw normalize(error);}
 if(credentials.accountId!==PRODUCTION_ACCOUNT_ID)throw new OperatorStop('account_mismatch',3);
 if(credentials.bucket!==PRODUCTION_DATABASE_NAME)throw new OperatorStop('bucket_identity',3);
 return createS3Store({credentials,fetchImpl});
}
// The bucket the importer and the freeze audit read through. The listing is ONE PAGE per call (`listPage`), so the importer's own page bound (MAX_LIST_PAGES) applies and a truncated page without a continuation token, or
// a repeated token, is an incomplete listing (a STOP), never a short complete one. `store.listPage`, `get` and `head` are the only calls: this bucket has no write.
export function bucketOf(store){
 const seen=new Set();
 return {
  async list({prefix,limit,cursor}={}){
   if(!cursor)seen.clear();
   const page=await store.listPage({prefix,limit,cursor});
   if(page.truncated){
    if(!page.cursor)throw new OperatorStop('listing_incomplete',3,{reason:'missing_continuation'});
    if(page.cursor===cursor||seen.has(page.cursor))throw new OperatorStop('listing_incomplete',3,{reason:'repeated_continuation'});
    seen.add(page.cursor);
   }
   return {objects:page.objects,truncated:page.truncated,cursor:page.cursor};
  },
  get:key=>store.get(key),
  head:key=>store.head(key),
 };
}

export async function runLetterboxdAdmissionCutover({argv=process.argv,env=process.env,fetchImpl=globalThis.fetch,now=()=>Date.now(),deps=null}={}){
 const ctx={writeState:'none',bookmark:null};
 const track=state=>{ctx.writeState=state;};
 try{
  const parsed=parseArgs(argv);
  if(parsed.report)return {exit:0,result:parsed.report};
  let binding,bucket=null,target=null;
  if(deps)({binding,bucket=null}=deps);
  else{
   target=productionTarget(env);
   const adapter=createD1Adapter({target,databaseId:PRODUCTION_DATABASE_ID,fetchImpl,retries:0});
   const described=await adapter.describe();
   if(described.uuid!==PRODUCTION_DATABASE_ID||described.name!==PRODUCTION_DATABASE_NAME)throw new OperatorStop('target_identity_mismatch',3);
   const tracked=trackProductionWrites(adapter,ctx);
   binding=strictBinding(createPublishedBinding(tracked),adapter);
   if(!['reopen','rollback-import'].includes(parsed.command))bucket=bucketOf(readStoreOf(env,fetchImpl));
   if(WRITES.includes(parsed.command))ctx.bookmark=await readBookmark(target,fetchImpl);
  }
  const result=await execute(parsed.command,{binding,bucket,args:parsed.args,now,ctx:{track}});
  let bookmarkAfter=null;
  if(result.writes&&target)try{bookmarkAfter=await readBookmark(target,fetchImpl);}catch{bookmarkAfter=null;}
  return {exit:0,result:{...result,...(ctx.bookmark?{bookmarkBefore:ctx.bookmark}:{}),...(bookmarkAfter?{bookmarkAfter}:{})}};
 }catch(error){
  const stop=normalize(error);
  const writeState=ctx.writeState==='committed'||ctx.writeState==='unknown'?ctx.writeState:'none';
  return {exit:stop.exit,result:{reason:stop.reason,writeState,writes:writeState==='committed'?true:writeState==='unknown'?null:false,...(writeState!=='none'?{retry:false}:{}),...(stop.details&&Object.keys(stop.details).length?{details:stop.details}:{}),...(ctx.bookmark?{bookmarkBefore:ctx.bookmark}:{})}};
 }
}
const invoked=process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href;
if(invoked){
 const {exit,result}=await runLetterboxdAdmissionCutover();
 if(result.reason)process.stderr.write(result.reason+'\n');
 process.stdout.write(JSON.stringify(result)+'\n');
 process.exitCode=exit;
}
