// Owner-confirmed apply of one previewed Letterboxd archive chunk (ADR 0068), behind the same Cloudflare Access
// application as the preview. The browser sends the ZIP again on confirm and again on commit. This module stores the
// issued confirmation and, after a second request, the receipt. It never stores the archive, its rows, film names or
// rating values. Fact writes go through LetterboxdFacts.commitBaselineChunk only after checkSubmission. Preview does
// not call this. LETTERBOXD_FACTS and LETTERBOXD_BASELINE_IMPORT are not consulted.
const LBA_APPLY_PREFIX='admin/actions/letterboxd_archive_apply/v1/';
const LBA_ROLLBACK_PREFIX='admin/actions/letterboxd_archive_rollback/v1/';
const LBA_CONFIRM_FIELDS={chunk:5,planHash:64,programmeRunId:80,scopeFingerprint:8,idempotencyKey:80,accepted:5};
const LBA_COMMIT_FIELDS={confirmation:24000};
const LBA_HEX64=/^[0-9a-f]{64}$/,LBA_FP=/^[0-9a-f]{8}$/,LBA_RUN=/^[A-Za-z0-9_-]{1,80}$/,LBA_KEY=/^[A-Za-z0-9_-]{16,80}$/;
const LBA_APPLY_CAP=AdminActions.defineCapability({
 id:'letterboxd_archive_apply',version:1,title:'Apply one chunk of a previewed Letterboxd archive',
 subjectKinds:['letterboxd_archive_chunk'],healthActionCode:'letterboxd_archive_apply',
 budget:{maxRecords:50,maxWritesPerRecord:3,externalCallsPerRecord:0},retry:{maxAttempts:1,backoffMs:0},
 compensation:{kind:'restore_before_image',guidance:'Rollback is a separate owner confirmation of this chunk. A later observation is kept.'},
 confirmTtlMs:10*60000,
});
const LBA_ROLLBACK_CAP=AdminActions.defineCapability({
 id:'letterboxd_archive_rollback',version:1,title:'Roll back one committed Letterboxd archive chunk',
 subjectKinds:['letterboxd_archive_chunk'],healthActionCode:'letterboxd_archive_rollback',
 budget:{maxRecords:1,maxWritesPerRecord:3,externalCallsPerRecord:0},retry:{maxAttempts:1,backoffMs:0},
 compensation:{kind:'restore_before_image',guidance:'A second rollback of the same chunk is a replay. A later observation is kept.'},
 confirmTtlMs:10*60000,
});
const LBA_APPLY_REGISTRY=AdminActions.createRegistry([LBA_APPLY_CAP,LBA_ROLLBACK_CAP]);

function lbaRefuse(refusal,status,extra={}){return json({error:refusal,refusal,...extra},status);}
function lbaPrincipal(request,url){
 const assertion=request.headers.get('Cf-Access-Jwt-Assertion');
 return {owner:typeof assertion==='string'&&assertion.length>0&&assertion.length<=8192&&request.headers.get('Origin')===url.origin&&request.headers.get('X-IPTV-Admin-Action')==='letterboxd_archive_apply'};
}
function lbaBucket(env){return !!(env&&env.BUCKET&&typeof env.BUCKET.get==='function'&&typeof env.BUCKET.put==='function');}
function lbaMultipartGate(request){
 const contentType=request.headers.get('Content-Type')||'';
 if(!/^multipart\/form-data;\s*boundary=/i.test(contentType))return adminError('unsupported_media_type',415);
 const maxBody=LetterboxdArchiveZip.ARCHIVE_LIMITS.maxArchiveBytes+LBA_FORM_OVERHEAD;
 const length=request.headers.get('Content-Length');
 if(length===null||!/^\d{1,12}$/.test(length))return adminError('length_required',411);
 if(Number(length)>maxBody)return adminError('archive_too_large',413);
 return null;
}
function lbaProgrammePin(comparison){
 const source=comparison.sources&&comparison.sources.programme;
 return source&&source.evidence==='observed'&&LBA_RUN.test(source.programmeRunId||'')?source.programmeRunId:null;
}
function lbaApplyPreview(sha,chunk,pin,records,now){
 const subject={kind:'letterboxd_archive_chunk',id:sha+':'+chunk};
 return AdminActions.previewAction(LBA_APPLY_REGISTRY,{capability:LBA_APPLY_CAP.id,version:LBA_APPLY_CAP.version,subject,pin,ids:records.map(record=>record.id)},{pin,now,records,issues:records.map(record=>LetterboxdArchiveApply.applyIssue(record.id))});
}
async function lbaChunkPlan(comparison,chunkIndex){
 const batches=LetterboxdArchiveApply.splitBatches(LetterboxdArchiveApply.comparedFilms(comparison.items));
 const batch=batches.find(item=>item.chunk===chunkIndex);
 if(!batch)return null;
 const records=[];
 for(const film of batch.films)records.push({id:film.lid,version:await adminDigest(LetterboxdArchiveApply.versionText(film))});
 return {batch,planHash:await adminDigest(LetterboxdArchiveApply.planText(batch.items)),records};
}
function lbaActionKey(prefix,idempotencyKey){return prefix+idempotencyKey+'.json';}
async function lbaActionRead(env,prefix,idempotencyKey){
 const object=await env.BUCKET.get(lbaActionKey(prefix,idempotencyKey));
 return object?{record:await object.json(),etag:object.etag??null}:{record:null,etag:null};
}
async function lbaActionWrite(env,prefix,idempotencyKey,record,etag){
 return await env.BUCKET.put(lbaActionKey(prefix,idempotencyKey),JSON.stringify(record),{httpMetadata:{contentType:'application/json'},onlyIf:etag?{etagMatches:etag}:{etagDoesNotMatch:'*'}});
}
// The scope is the confirmation. The clock fields are not: a retry of the same key returns the stored issuance and its
// original expiry, so a later clock cannot mint a new TTL or look like a different confirmation.
const LBA_ISSUED_SCOPE=['schemaVersion','capability','version','subject','pin','scopeKey','scopeFingerprint','ids','idempotencyKey'];
function lbaSameIssued(stored,issued){
 return !!stored&&!!issued&&LBA_ISSUED_SCOPE.every(key=>JSON.stringify(stored[key])===JSON.stringify(issued[key]));
}
function lbaIssuedRecords(issued){
 try{const scope=JSON.parse(issued&&issued.scopeKey);return Array.isArray(scope.records)?scope.records:null;}catch{return null;}
}
// An intent or receipt whose items hash is this action's plan is this plan. A different hash is another plan and must not
// be completed or overwritten. A missing object is neither.
async function lbaOwnBaseline(env,sha,chunk,planHash){
 const [intent,receipt]=await Promise.all([lbaObject(env,lbaImportObject(sha,chunk,'intent')),lbaObject(env,lbaImportObject(sha,chunk,'receipt'))]);
 if(intent.value===undefined||receipt.value===undefined)return {error:true,intent:false,receipt:false,foreign:false};
 const intentHash=intent.value&&typeof intent.value.itemsHash==='string'?intent.value.itemsHash:null;
 const receiptHash=receipt.value&&typeof receipt.value.itemsHash==='string'?receipt.value.itemsHash:null;
 return {error:false,intent:intentHash===planHash,receipt:receiptHash===planHash,foreign:(!!intentHash&&intentHash!==planHash)||(!!receiptHash&&receiptHash!==planHash)};
}
function lbaImportObject(sha,chunk,kind){return 'letterboxd/imports/'+sha+'/chunks/'+chunk+'.'+kind+'.json';}
async function lbaObject(env,key){
 try{const object=await env.BUCKET.get(key);return object?{value:await object.json(),etag:object.etag??null}:{value:null,etag:null};}
 catch{return {value:undefined,etag:null};}
}

// Adds the approvable chunks to a preview answer. Hashes only; no write. Films the preview did not compare are absent.
async function lbaAttachBatches(answer,comparison,now){
 const pin=lbaProgrammePin(comparison),drift=comparison.consistency?.status!=='stable';
 const batches=LetterboxdArchiveApply.splitBatches(LetterboxdArchiveApply.comparedFilms(comparison.items));
 const chunks=[];
 for(const batch of batches){
  const records=[];
  for(const film of batch.films)records.push({id:film.lid,version:await adminDigest(LetterboxdArchiveApply.versionText(film))});
  const planHash=await adminDigest(LetterboxdArchiveApply.planText(batch.items));
  let scopeFingerprint=null,confirmable=false,reason=null;
  if(drift)reason='facts_changed_during_read';
  else if(!pin)reason='programme_unavailable';
  else{
   const preview=lbaApplyPreview(answer.archive.sha256,batch.chunk,pin,records,new Date(now).toISOString());
   scopeFingerprint=preview.scopeFingerprint||null;
   confirmable=preview.status==='eligible'&&!!scopeFingerprint;
   reason=confirmable?null:preview.reason||'not_eligible';
  }
  const source=batch.chunk===0&&comparison.receipt?comparison.receipt:{status:'not_read',committedAt:null};
  chunks.push({chunk:batch.chunk,films:batch.films.length,planHash,scopeFingerprint,changes:LetterboxdArchiveApply.changeCounts(batch.films),confirmable,reason,receipt:{status:source.status,committedAt:source.committedAt??null}});
 }
 const reason=!chunks.length?'no_compared_films':drift?'facts_changed_during_read':!pin?'programme_unavailable':null;
 answer.batches={size:LetterboxdArchiveApply.APPLY_BATCH_SIZE,programmeRunId:pin,confirmable:chunks.some(chunk=>chunk.confirmable),reason,chunks};
}

function lbaCommitOutcomes(result,ids){
 const replay=result.replay===true;
 const byLid=new Map((result.entries||[]).map(entry=>{
  if(replay)return [entry.lid,{id:entry.lid,outcome:'already_applied'}];
  if(entry.conflict)return [entry.lid,{id:entry.lid,outcome:'failed',error:'conflict'}];
  const outcomes=entry.outcomes||[];
  if(outcomes.some(item=>item.outcome==='new'||item.outcome==='replaces'))return [entry.lid,{id:entry.lid,outcome:'written'}];
  if(outcomes.some(item=>item.outcome==='older'))return [entry.lid,{id:entry.lid,outcome:'skipped_changed'}];
  return [entry.lid,{id:entry.lid,outcome:'already_applied'}];
 }));
 return ids.map(id=>byLid.get(id)||{id,outcome:'unknown'});
}
function lbaBaselineView(result){
 return {chunk:result.chunk,replay:result.replay===true,conflicts:result.conflicts||0,outcomes:result.outcomes||{}};
}

async function lbaApplyConfirm(request,env,url){
 const gate=lbaMultipartGate(request);
 if(gate)return gate;
 const started=Date.now();
 if(!lbaTrySlot(started))return lbaRefuse('preview_busy',429);
 try{
  const opened=await lbaIngest(request,LBA_CONFIRM_FIELDS,started,request.signal||null);
  if(opened.response)return opened.response;
  const fields=opened.extra,chunk=Number(fields.chunk);
  if(!LBA_CHUNK_OK(fields,chunk))return lbaRefuse('invalid_request',400);
  const comparison=await lbaCompare(env,opened.parsed,opened.origin);
  if(comparison.consistency?.status!=='stable')return lbaRefuse('record_changed',409);
  const pin=lbaProgrammePin(comparison);
  if(!pin||fields.programmeRunId!==pin)return lbaRefuse('stale_pin',409,{pin});
  const plan=await lbaChunkPlan(comparison,chunk);
  if(!plan||plan.planHash!==fields.planHash)return lbaRefuse('invalid_request',400);
  const now=new Date(started).toISOString();
  const preview=lbaApplyPreview(opened.origin.sha256,chunk,pin,plan.records,now);
  if(preview.scopeFingerprint!==fields.scopeFingerprint)return lbaRefuse('record_changed',409);
  if(preview.status!=='eligible')return lbaRefuse('not_eligible',409,{reason:preview.reason});
  const issued=AdminActions.confirmAction(preview,{now,idempotencyKey:fields.idempotencyKey,accepted:true});
  if(issued.error)return lbaRefuse(issued.error,409);
  const existing=await lbaActionRead(env,LBA_APPLY_PREFIX,fields.idempotencyKey);
  if(existing.record){
   if(lbaSameIssued(existing.record.issued,issued))return json({mode:'apply_confirm',writes:false,confirmation:existing.record.issued,batch:{chunk,films:plan.batch.films.length,planHash:plan.planHash,scopeFingerprint:preview.scopeFingerprint}});
   return lbaRefuse('idempotency_conflict',409);
  }
  const record={schemaVersion:1,kind:'letterboxd_archive_apply',idempotencyKey:fields.idempotencyKey,state:'approved',issued,createdAt:now,startedAt:null,finishedAt:null,archiveSha256:opened.origin.sha256,generatedAt:opened.origin.generatedAt,generatedAtSource:opened.origin.generatedAtSource,chunk,planHash:plan.planHash,programmeRunId:pin,receipt:null,baseline:null};
  const saved=await lbaActionWrite(env,LBA_APPLY_PREFIX,fields.idempotencyKey,record,null);
  if(saved===null)return lbaRefuse('idempotency_conflict',409);
  return json({mode:'apply_confirm',writes:false,confirmation:issued,batch:{chunk,films:plan.batch.films.length,planHash:plan.planHash,scopeFingerprint:preview.scopeFingerprint}});
 }catch{return lbaRefuse('invalid_request',500);}
 finally{lbaFreeSlot(started);}
}
function LBA_CHUNK_OK(fields,chunk){
 return typeof fields.chunk==='string'&&/^(0|[1-9]\d{0,4})$/.test(fields.chunk)&&Number(fields.chunk)===chunk&&chunk<=10000&&LBA_HEX64.test(fields.planHash||'')&&LBA_RUN.test(fields.programmeRunId||'')&&LBA_FP.test(fields.scopeFingerprint||'')&&LBA_KEY.test(fields.idempotencyKey||'')&&fields.accepted==='true';
}

async function lbaApplyCommit(request,env,url){
 const gate=lbaMultipartGate(request);
 if(gate)return gate;
 const started=Date.now();
 if(!lbaTrySlot(started))return lbaRefuse('preview_busy',429);
 try{
  const opened=await lbaIngest(request,LBA_COMMIT_FIELDS,started,request.signal||null);
  if(opened.response)return opened.response;
  let confirmation;
  try{confirmation=JSON.parse(opened.extra.confirmation||'');}catch{return lbaRefuse('invalid_request',400);}
  const submitted=AdminActions.validateConfirmation(confirmation);
  if(!submitted||submitted.capability!==LBA_APPLY_CAP.id)return lbaRefuse('invalid_request',400);
  let stored=await lbaActionRead(env,LBA_APPLY_PREFIX,submitted.idempotencyKey);
  if(!stored.record||!stored.record.issued)return lbaRefuse('confirmation_missing',409);
  if(stored.record.archiveSha256!==opened.origin.sha256||stored.record.generatedAt!==opened.origin.generatedAt||stored.record.generatedAtSource!==opened.origin.generatedAtSource)return lbaRefuse('confirmation_mismatch',409);
  if(submitted.subject.id!==opened.origin.sha256+':'+stored.record.chunk)return lbaRefuse('confirmation_mismatch',409);
  if(stored.record.receipt)return json({mode:'apply',writes:false,replayed:true,receipt:stored.record.receipt,baseline:stored.record.baseline,state:stored.record.state});
  const comparison=await lbaCompare(env,opened.parsed,opened.origin);
  if(comparison.consistency?.status!=='stable')return lbaRefuse('record_changed',409);
  const pin=lbaProgrammePin(comparison);
  const plan=await lbaChunkPlan(comparison,stored.record.chunk);
  if(!pin)return lbaRefuse('stale_pin',409);
  if(!plan||plan.planHash!==stored.record.planHash)return lbaRefuse('record_changed',409);
  const now=new Date().toISOString();
  const own=await lbaOwnBaseline(env,opened.origin.sha256,stored.record.chunk,stored.record.planHash);
  if(own.error)return json({error:'storage_error'},500);
  if(own.foreign)return lbaRefuse('idempotency_conflict',409);
  // A running action whose own intent or receipt is already stored has written some of the versions a fresh read would
  // hash. Those versions are not a new scope. The issued scope still has to match, and a newer observation is kept by
  // the baseline merge. An action that has not opened an intent still uses the fresh versions.
  const resume=stored.record.state==='running'&&(own.intent||own.receipt);
  const records=resume?lbaIssuedRecords(stored.record.issued):plan.records;
  if(!records)return lbaRefuse('invalid_request',400);
  const fresh={pin,now,records,issues:records.map(record=>LetterboxdArchiveApply.applyIssue(record.id))};
  const checked=AdminActions.checkSubmission(LBA_APPLY_REGISTRY,confirmation,fresh,{principal:lbaPrincipal(request,url),issued:stored.record.issued});
  if(!checked.ok)return lbaRefuse(checked.refusal,checked.refusal==='confirmation_expired'||checked.refusal==='invalid_request'?400:409);
  if(stored.record.state!=='running'){
   const running={...stored.record,state:'running',startedAt:now};
   const marked=await lbaActionWrite(env,LBA_APPLY_PREFIX,submitted.idempotencyKey,running,stored.etag);
   if(marked===null)return lbaRefuse('in_progress',409);
   stored={record:running,etag:marked.etag};
  }
  let result;
  try{
   result=await LetterboxdFacts.commitBaselineChunk(env,{origin:{archiveSha256:opened.origin.sha256,generatedAt:opened.origin.generatedAt,generatedAtSource:opened.origin.generatedAtSource},chunk:stored.record.chunk,items:plan.batch.items});
  }catch(error){
   if(error instanceof LetterboxdFacts.FactsError&&error.code==='chunk_conflict')return lbaRefuse('idempotency_conflict',409);
   return json({error:'storage_error'},500);
  }
  const outcomes=lbaCommitOutcomes(result,submitted.ids);
  const receipt=AdminActions.receiptOf({confirmation,capability:LBA_APPLY_CAP,startedAt:stored.record.startedAt,finishedAt:new Date().toISOString(),outcomes});
  const baseline=lbaBaselineView(result);
  const saved={...stored.record,state:receipt.state,finishedAt:receipt.finishedAt,receipt,baseline};
  const durable=await lbaActionWrite(env,LBA_APPLY_PREFIX,submitted.idempotencyKey,saved,stored.etag);
  return json({mode:'apply',writes:result.replay!==true,replayed:result.replay===true,receipt,baseline,state:receipt.state,durable:durable!==null});
 }catch{return lbaRefuse('invalid_request',500);}
 finally{lbaFreeSlot(started);}
}

function lbaRollbackPreview(sha,chunk,pin,now){
 const subject={kind:'letterboxd_archive_chunk',id:sha+':rollback:'+chunk};
 return AdminActions.previewAction(LBA_APPLY_REGISTRY,{capability:LBA_ROLLBACK_CAP.id,version:LBA_ROLLBACK_CAP.version,subject,pin,ids:['chunk']},{pin,now,records:[{id:'chunk',version:pin}],issues:[LetterboxdArchiveApply.rollbackIssue()]});
}
async function lbaRollbackBody(request){
 const type=(request.headers.get('Content-Type')||'').split(';')[0].trim().toLowerCase();
 if(type!=='application/json')return {response:adminError('unsupported_media_type',415)};
 let text;try{text=await request.text();}catch{return {response:lbaRefuse('invalid_request',400)};}
 if(!text||text.length>16384)return {response:lbaRefuse('invalid_request',400)};
 try{const body=JSON.parse(text);if(!body||typeof body!=='object'||Array.isArray(body))return {response:lbaRefuse('invalid_request',400)};return {body};}
 catch{return {response:lbaRefuse('invalid_request',400)};}
}
function lbaRollbackFields(body){
 const chunk=body.chunk;
 return LBA_HEX64.test(body.archiveSha256||'')&&Number.isInteger(chunk)&&chunk>=0&&chunk<=10000&&LBA_KEY.test(body.idempotencyKey||'')&&body.accepted===true;
}

async function lbaRollbackConfirm(request,env,url){
 const opened=await lbaRollbackBody(request);
 if(opened.response)return opened.response;
 const body=opened.body;
 if(body.accepted!==true)return lbaRefuse('confirmation_missing',400);
 if(!lbaRollbackFields(body))return lbaRefuse('invalid_request',400);
 const started=Date.now();
 if(!lbaTrySlot(started))return lbaRefuse('preview_busy',429);
 try{
  const receipt=await lbaObject(env,lbaImportObject(body.archiveSha256,body.chunk,'receipt'));
  if(receipt.value===undefined)return lbaRefuse('invalid_request',503);
  if(!receipt.value||typeof receipt.value.itemsHash!=='string'||!LBA_HEX64.test(receipt.value.itemsHash)||!receipt.value.origin)return lbaRefuse('not_eligible',409);
  const now=new Date(started).toISOString();
  const preview=lbaRollbackPreview(body.archiveSha256,body.chunk,receipt.value.itemsHash,now);
  if(preview.status!=='eligible')return lbaRefuse('not_eligible',409,{reason:preview.reason});
  const issued=AdminActions.confirmAction(preview,{now,idempotencyKey:body.idempotencyKey,accepted:true});
  if(issued.error)return lbaRefuse(issued.error,409);
  const existing=await lbaActionRead(env,LBA_ROLLBACK_PREFIX,body.idempotencyKey);
  if(existing.record){
   if(lbaSameIssued(existing.record.issued,issued))return json({mode:'rollback_confirm',writes:false,confirmation:existing.record.issued});
   return lbaRefuse('idempotency_conflict',409);
  }
  const record={schemaVersion:1,kind:'letterboxd_archive_rollback',idempotencyKey:body.idempotencyKey,state:'approved',issued,createdAt:now,archiveSha256:body.archiveSha256,chunk:body.chunk,itemsHash:receipt.value.itemsHash,receipt:null};
  const saved=await lbaActionWrite(env,LBA_ROLLBACK_PREFIX,body.idempotencyKey,record,null);
  if(saved===null)return lbaRefuse('idempotency_conflict',409);
  return json({mode:'rollback_confirm',writes:false,confirmation:issued});
 }catch{return lbaRefuse('invalid_request',500);}
 finally{lbaFreeSlot(started);}
}

async function lbaRollback(request,env,url){
 const opened=await lbaRollbackBody(request);
 if(opened.response)return opened.response;
 let confirmation=opened.body.confirmation;
 if(typeof confirmation==='string'){try{confirmation=JSON.parse(confirmation);}catch{return lbaRefuse('invalid_request',400);}}
 const submitted=AdminActions.validateConfirmation(confirmation);
 if(!submitted||submitted.capability!==LBA_ROLLBACK_CAP.id)return lbaRefuse('invalid_request',400);
 const started=Date.now();
 if(!lbaTrySlot(started))return lbaRefuse('preview_busy',429);
 try{
  let stored=await lbaActionRead(env,LBA_ROLLBACK_PREFIX,submitted.idempotencyKey);
  if(!stored.record||!stored.record.issued)return lbaRefuse('confirmation_missing',409);
  if(stored.record.receipt)return json({mode:'rollback',writes:false,replayed:true,receipt:stored.record.receipt,state:stored.record.state});
  const sha=stored.record.archiveSha256,chunk=stored.record.chunk;
  if(submitted.subject.id!==sha+':rollback:'+chunk)return lbaRefuse('confirmation_mismatch',409);
  const receipt=await lbaObject(env,lbaImportObject(sha,chunk,'receipt'));
  if(receipt.value===undefined)return lbaRefuse('invalid_request',503);
  if(!receipt.value||receipt.value.itemsHash!==stored.record.itemsHash)return lbaRefuse('record_changed',409);
  const now=new Date().toISOString();
  const fresh={pin:receipt.value.itemsHash,now,records:[{id:'chunk',version:receipt.value.itemsHash}],issues:[LetterboxdArchiveApply.rollbackIssue()]};
  const checked=AdminActions.checkSubmission(LBA_APPLY_REGISTRY,confirmation,fresh,{principal:lbaPrincipal(request,url),issued:stored.record.issued});
  if(!checked.ok)return lbaRefuse(checked.refusal,checked.refusal==='confirmation_expired'||checked.refusal==='invalid_request'?400:409);
  let result;
  try{result=await LetterboxdFacts.rollbackBaselineChunk(env,{origin:receipt.value.origin,chunk});}
  catch(error){if(error instanceof LetterboxdFacts.FactsError&&error.code==='not_committed')return lbaRefuse('not_eligible',409);return lbaRefuse('invalid_request',500);}
  const superseded=(result.facts&&result.facts.superseded)||0,restored=(result.facts&&result.facts.restored)||0;
  const outcome=result.replay? 'already_applied':restored? 'written':superseded? 'skipped_changed':'already_applied';
  const actionReceipt=AdminActions.receiptOf({confirmation,capability:LBA_ROLLBACK_CAP,startedAt:now,finishedAt:new Date().toISOString(),outcomes:[{id:'chunk',outcome}]});
  const saved={...stored.record,state:actionReceipt.state,finishedAt:actionReceipt.finishedAt,receipt:actionReceipt,rollback:{replay:result.replay===true,restored,superseded}};
  await lbaActionWrite(env,LBA_ROLLBACK_PREFIX,submitted.idempotencyKey,saved,stored.etag);
  return json({mode:'rollback',writes:result.replay!==true,replayed:result.replay===true,receipt:actionReceipt,rollback:saved.rollback,state:actionReceipt.state});
 }catch{return lbaRefuse('invalid_request',500);}
 finally{lbaFreeSlot(started);}
}

async function lbaApplyRoute(request,env,url){
 if(request.method!=='POST')return adminError('method_not_allowed',405);
 if(!lbaPrincipal(request,url).owner)return lbaRefuse('access_denied',403);
 if(!lbaBucket(env))return json({error:'storage_unavailable'},503);
 const path=url.pathname;
 if(path==='/api/admin/letterboxd-archive/rollback-confirm')return lbaRollbackConfirm(request,env,url);
 if(path==='/api/admin/letterboxd-archive/rollback')return lbaRollback(request,env,url);
 if(path==='/api/admin/letterboxd-archive/apply-confirm')return lbaApplyConfirm(request,env,url);
 if(path==='/api/admin/letterboxd-archive/apply')return lbaApplyCommit(request,env,url);
 return adminError('not_found',404);
}
