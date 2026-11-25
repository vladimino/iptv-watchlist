// AIR-602 / ADR 0222 (owner option B on PR #1018), the offline import / parity / rollback mechanism for the Letterboxd import coordination documents.
// DORMANT: nothing in the Worker imports this module, it is not bundled, and no route, Workflow, cron or producer calls it. The first `d1` activation (card A2, AIR-608) runs it inside its owner-approved
// plan, under marker `closed` and after the drain of every old writer; this card delivers and tests the mechanism only. It performs no production copy by itself and is never run by a deploy.
//
// What it provides:
// - `inventory(bucket)`: ONE bounded, paged, read-only listing of `letterboxd/imports/` and a read of every key of the moved families (`admissionDocumentKey`): rated-candidates, chunk intent / receipt / candidates
//   result. Everything else under the prefix (the registry projection, ZIP and HTML evidence) is counted as `ignored` and never read. A key list that hits the cap is `truncated` and blocks the plan.
// - `planImport(snapshot)`: PURE. Freezes the cohort (key, R2 etag, byte size, SHA-256 of the text), refuses an unparseable or oversized document and an unknown key shape (`blocked`), and prints the SHA-256 of the
//   manifest the owner's import GO names. Nothing here reads D1.
// - `importDocuments(env, plan)`: idempotent. Requires marker `closed` (read fresh, asserted in every batch at that generation). Each document is written by the Ratings compare-and-swap (create only); a document
//   already in D1 with the same SHA-256 is skipped (a lost response is answered by resending); one with another SHA-256 is a `diverged` stop, never an overwrite. The COMPLETE manifest is written LAST, so
//   the `d1` readers (which require it) fail closed for any absent or partial import, and an empty document set still ends with a manifest (missing is not empty).
// - `verifyParity(env, plan, bucket)`: read-only. Re-reads the R2 snapshot (a changed etag or a new or removed key is `r2_drift`: a late writer) and every D1 document byte for byte; `equal` only when the key
//   set, every SHA-256 and the manifest agree.
// - `rollbackImport(env)`: BEFORE the flip only (marker `r2` or `closed`; the batch asserts it): deletes the D1 copies and the manifest in one fenced batch. R2 stayed authoritative, so this loses nothing.
//   After the flip there is no rollback: recovery is roll-forward on code that honours the marker (ADR 0207 decision 1).
import {createHash} from 'node:crypto';
import {ADMISSION_DOCUMENT_BYTES,admissionDocumentKey,putOwned,readOwned} from './ratings-d1.js';
import {admissionRoute,readAdmissionAuthority} from './letterboxd-admission-authority.js';
import {database} from './film-person-authority.js';

export const IMPORT_PREFIX='letterboxd/imports/';
export const MANIFEST_KEY='letterboxd/imports/documents-manifest.json';
export const MANIFEST_SCHEMA=1;
export const MAX_KEYS=5000;
const PAGE=1000;

const sha256=text=>createHash('sha256').update(text).digest('hex');
function failed(code,detail){const error=new Error(code);error.code=code;if(detail!==undefined)error.detail=detail;return error;}

// -> {documents:[{key,etag,text}], ignored, truncated}. `bucket` is read only here: `list` and `get`.
export async function inventory(bucket){
 const documents=[];let ignored=0,cursor,seen=0,truncated=false;
 for(;;){
  const page=await bucket.list({prefix:IMPORT_PREFIX,limit:PAGE,...(cursor?{cursor}:{})});
  for(const object of page.objects||[]){
   seen++;
   if(seen>MAX_KEYS){truncated=true;break;}
   if(object.key===MANIFEST_KEY||!admissionDocumentKey(object.key)){ignored++;continue;}
   const body=await bucket.get(object.key);
   if(!body){documents.push({key:object.key,etag:null,text:null,missing:true});continue;}
   documents.push({key:object.key,etag:body.etag??null,text:await body.text()});
  }
  if(truncated||!page.truncated)break;
  cursor=page.cursor;
 }
 documents.sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);
 return {documents,ignored,truncated};
}

// PURE. -> {blocked:[{key,reason}], documents:[{key,etag,bytes,sha256,text}], manifest, manifestSha256}. A plan with `blocked` entries or a truncated listing has no manifest.
export function planImport(snapshot){
 const blocked=[],documents=[];
 if(snapshot.truncated)blocked.push({key:IMPORT_PREFIX,reason:'inventory_truncated'});
 for(const item of snapshot.documents){
  if(item.missing||item.text===null){blocked.push({key:item.key,reason:'vanished_during_inventory'});continue;}
  if(!admissionDocumentKey(item.key)){blocked.push({key:item.key,reason:'unknown_key'});continue;}
  if(item.text.length>ADMISSION_DOCUMENT_BYTES){blocked.push({key:item.key,reason:'oversized'});continue;}
  let value;try{value=JSON.parse(item.text);}catch{blocked.push({key:item.key,reason:'unparseable'});continue;}
  if(value===null||typeof value!=='object'||Array.isArray(value)){blocked.push({key:item.key,reason:'not_an_object'});continue;}
  // The D1 store holds the canonical JSON text of the value; the digest is of that text, so a re-serialization difference is never read as drift.
  const text=JSON.stringify(value);
  documents.push({key:item.key,etag:item.etag,bytes:text.length,sha256:sha256(text),value});
 }
 if(blocked.length)return {blocked,documents,manifest:null,manifestSha256:null};
 const keys=documents.map(({key,etag,bytes,sha256:digest})=>({key,etag,bytes,sha256:digest}));
 const manifest={schemaVersion:MANIFEST_SCHEMA,complete:true,count:keys.length,inventorySha256:sha256(JSON.stringify(keys)),keys};
 return {blocked,documents,manifest,manifestSha256:sha256(JSON.stringify(manifest))};
}

const closedAssertion=generation=>['UPDATE ratings_domain_cas SET ok=CASE WHEN EXISTS (SELECT 1 FROM letterboxd_admission_authority WHERE id=1 AND mode=\'closed\' AND generation=?) THEN 1 ELSE 0 END WHERE id=1',[generation]];
const beforeFlipAssertion=generation=>['UPDATE ratings_domain_cas SET ok=CASE WHEN EXISTS (SELECT 1 FROM letterboxd_admission_authority WHERE id=1 AND mode IN (\'r2\',\'closed\') AND generation=?) THEN 1 ELSE 0 END WHERE id=1',[generation]];

async function closedAuthority(env){
 const authority=await readAdmissionAuthority(env);
 if(admissionRoute(authority)!=='closed')throw failed('import_requires_closed',authority.mode);
 return authority;
}

async function put(env,key,value,authority){
 const out=await putOwned(env,key,null,value,{extra:[closedAssertion(authority.generation)],admission:true});
 if(!out.owned)throw failed('ratings_domain_unavailable');
 return out;
}

// -> {imported, skipped, manifest:'written'|'present'}. Throws `import_blocked` (a plan with blocked entries), `import_requires_closed`, `diverged` (a D1 document differs from the plan: rollback and re-import).
export async function importDocuments(env,plan){
 if(plan.blocked.length||!plan.manifest)throw failed('import_blocked',plan.blocked);
 const authority=await closedAuthority(env);
 const present=await readOwned(env,MANIFEST_KEY,{admission:true});
 if(!present.owned)throw failed('ratings_domain_unavailable');
 if(present.value){
  if(present.value.inventorySha256!==plan.manifest.inventorySha256)throw failed('diverged',{key:MANIFEST_KEY});
 }
 let imported=0,skipped=0;
 for(const item of plan.documents){
  const stored=await readOwned(env,item.key,{admission:true});
  if(!stored.owned)throw failed('ratings_domain_unavailable');
  if(stored.value!==null&&stored.value!==undefined){
   if(sha256(JSON.stringify(stored.value))!==item.sha256)throw failed('diverged',{key:item.key});
   skipped++;continue;
  }
  const out=await put(env,item.key,item.value,authority);
  if(out.saved)imported++;
  else{
   // refused or lost the create race: only an identical document already there is acceptable
   const again=await readOwned(env,item.key,{admission:true});
   if(!again.value||sha256(JSON.stringify(again.value))!==item.sha256)throw failed('diverged',{key:item.key});
   skipped++;
  }
 }
 if(present.value){return {imported,skipped,manifest:'present'};}
 const written=await put(env,MANIFEST_KEY,plan.manifest,authority);
 if(!written.saved){
  const again=await readOwned(env,MANIFEST_KEY,{admission:true});
  if(!again.value||again.value.inventorySha256!==plan.manifest.inventorySha256)throw failed('diverged',{key:MANIFEST_KEY});
  return {imported,skipped,manifest:'present'};
 }
 return {imported,skipped,manifest:'written'};
}

// -> {equal, differences:[{key,kind}]}; kinds: `r2_drift` (an R2 etag changed, or a key was added or removed since the snapshot: a late writer), `missing_in_d1`, `d1_differs`, `d1_extra`, `manifest_missing`, `manifest_differs`.
export async function verifyParity(env,plan,bucket){
 if(!plan.manifest)throw failed('import_blocked',plan.blocked);
 const differences=[];
 const now=await inventory(bucket);
 const planned=new Map(plan.documents.map(item=>[item.key,item]));
 const live=new Map(now.documents.map(item=>[item.key,item]));
 if(now.truncated)differences.push({key:IMPORT_PREFIX,kind:'r2_drift'});
 for(const [key,item] of planned){const seen=live.get(key);if(!seen||seen.etag!==item.etag)differences.push({key,kind:'r2_drift'});}
 for(const key of live.keys())if(!planned.has(key))differences.push({key,kind:'r2_drift'});
 for(const item of plan.documents){
  const stored=await readOwned(env,item.key,{admission:true});
  if(!stored.owned)throw failed('ratings_domain_unavailable');
  if(stored.value===null||stored.value===undefined)differences.push({key:item.key,kind:'missing_in_d1'});
  else if(sha256(JSON.stringify(stored.value))!==item.sha256)differences.push({key:item.key,kind:'d1_differs'});
 }
 const db=database(env);
 const rows=(await db.prepare("SELECT DISTINCT key FROM ratings_document WHERE part=0 AND key LIKE 'letterboxd/imports/%'").all()).results||[];
 for(const row of rows)if(admissionDocumentKey(row.key)&&row.key!==MANIFEST_KEY&&!planned.has(row.key))differences.push({key:row.key,kind:'d1_extra'});
 const manifest=await readOwned(env,MANIFEST_KEY,{admission:true});
 if(!manifest.value)differences.push({key:MANIFEST_KEY,kind:'manifest_missing'});
 else if(manifest.value.inventorySha256!==plan.manifest.inventorySha256||manifest.value.complete!==true)differences.push({key:MANIFEST_KEY,kind:'manifest_differs'});
 return {equal:differences.length===0,differences};
}

// Before the flip only. One fenced batch: the manifest first in statement order does not matter, the batch is atomic; it asserts the marker is `r2` or `closed` at the generation read, so it cannot run after `d1`.
export async function rollbackImport(env){
 const authority=await readAdmissionAuthority(env);
 const route=admissionRoute(authority);
 if(route==='d1')throw failed('rollback_after_flip');
 const db=database(env);
 const statements=[
  db.prepare(beforeFlipAssertion(authority.generation)[0]).bind(...beforeFlipAssertion(authority.generation)[1]),
  db.prepare("DELETE FROM ratings_document WHERE key LIKE 'letterboxd/imports/%' AND (key=? OR key LIKE '%/rated-candidates.json' OR key LIKE '%/chunks/%.intent.json' OR key LIKE '%/chunks/%.receipt.json' OR key LIKE '%/chunks/%.candidates.json')").bind(MANIFEST_KEY),
  db.prepare("UPDATE ratings_domain_authority SET generation=generation+1 WHERE id=1 AND mode='d1' AND cutover='open'").bind(),
 ];
 await db.batch(statements);
 return {rolledBack:true};
}
