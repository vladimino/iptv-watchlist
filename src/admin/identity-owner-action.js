// AIR-599 / ADR 0207 decision 4b. The owner `requeue` and `dismiss` of the shared Letterboxd check: Diary entries, backlog ids and Watchlist ledger rows.
//  POST /api/admin/identity-work/owner-action
//   {action:'requeue'|'dismiss', lane:'diary_identity'|'diary_backlog'|'watchlist_admission', lids:[1..50], why, version?, rows?, slugs?}
// The Worker itself verifies the Access JWT (signature, issuer, audience `ADMIN_ACCESS_AUD`, expiry, through the verifier `/mcp` uses) and the owner subject (`ADMIN_OWNER_EMAIL`), plus its own
// Origin, the action header and a JSON content type. Unconfigured is closed (503). Every write is one compare-and-swap on the token the owner saw (the document's stored `version`, or each ledger row's
// `state`, `attempts` and `updatedAt`); a moved token refuses the whole request (`stale_revision`, 409) and nothing is written. The answer carries a readback. It starts no check, no run and no Task.
const IDENTITY_OWNER_ACTION='letterboxd_check_owner_action';
const IDENTITY_OWNER_BODY_LIMIT=16384;
const IDENTITY_OWNER_LID=/^[A-Za-z0-9_-]{1,80}$/;
async function identityOwnerAccess(request,env){
 const owner=typeof env.ADMIN_OWNER_EMAIL==='string'?env.ADMIN_OWNER_EMAIL.trim().toLowerCase():'';
 if(!owner||typeof env.ADMIN_ACCESS_AUD!=='string'||!env.ADMIN_ACCESS_AUD.trim())return {ok:false,status:503,code:'owner_authorization_not_configured'};
 const access=await mcpVerifyAccess(request,env,{audience:env.ADMIN_ACCESS_AUD});
 if(!access.ok)return {ok:false,status:access.status===503?503:403,code:access.status===503?'owner_authorization_unavailable':'forbidden'};
 if(!access.email||access.email.trim().toLowerCase()!==owner)return {ok:false,status:403,code:'not_owner'};
 return {ok:true,by:access.email.trim().toLowerCase()};
}
async function identityOwnerBody(request){
 const length=request.headers.get('Content-Length');
 if(length!==null&&(!/^\d{1,9}$/.test(length)||Number(length)>IDENTITY_OWNER_BODY_LIMIT))return {error:'body_too_large'};
 let text;try{text=await request.text();}catch{return {error:'invalid_json'};}
 if(text.length>IDENTITY_OWNER_BODY_LIMIT)return {error:'body_too_large'};
 try{const value=JSON.parse(text);return value&&typeof value==='object'&&!Array.isArray(value)?{value}:{error:'invalid_json'};}catch{return {error:'invalid_json'};}
}
// Pure validation of the request body. -> {action,lane,lids,why,version,rows,slugs} | {error}
function identityOwnerRequest(body){
 const action=body.action,lane=body.lane;
 if(!['requeue','dismiss'].includes(action))return {error:'invalid_action'};
 if(!['diary_identity','diary_backlog','watchlist_admission'].includes(lane))return {error:'invalid_lane'};
 const lids=body.lids;
 if(!Array.isArray(lids)||!lids.length||lids.length>50||lids.some(lid=>typeof lid!=='string'||!IDENTITY_OWNER_LID.test(lid))||new Set(lids).size!==lids.length)return {error:'invalid_lids'};
 if(typeof body.why!=='string'||!body.why.trim()||body.why.length>200)return {error:'invalid_why'};
 // The shared check document (or the backlog) is written in every request, atomically with the ledger rows: its stored version is always the compare-and-swap token.
 if(!Object.hasOwn(body,'version'))return {error:'version_required'};
 if(Object.hasOwn(body,'version')&&body.version!==null&&(typeof body.version!=='string'||!body.version||body.version.length>200))return {error:'invalid_version'};
 let rows=null;
 if(lane==='watchlist_admission'){
  if(!Array.isArray(body.rows)||body.rows.length!==lids.length)return {error:'rows_required'};
  rows=body.rows.map(row=>({lid:row?.lid,state:row?.state,attempts:row?.attempts,updatedAt:row?.updatedAt}));
  if(rows.some((row,i)=>row.lid!==lids[i]||!['pending','terminal'].includes(row.state)||!Number.isInteger(row.attempts)||typeof row.updatedAt!=='string'||!row.updatedAt))return {error:'invalid_rows'};
 }
 const slugs={};
 if(body.slugs!==undefined){
  if(!body.slugs||typeof body.slugs!=='object'||Array.isArray(body.slugs))return {error:'invalid_slugs'};
  for(const [lid,slug] of Object.entries(body.slugs)){if(!lids.includes(lid)||typeof slug!=='string'||!/^[a-z0-9-]{1,200}$/.test(slug))return {error:'invalid_slugs'};slugs[lid]=slug;}
 }
 return {action,lane,lids,why:body.why.trim(),version:Object.hasOwn(body,'version')?body.version:undefined,rows,slugs};
}
async function adminIdentityOwnerActionRoute(request,env,url){
 if(request.method!=='POST')return adminError('method_not_allowed',405);
 if(request.headers.get('Origin')!==url.origin)return adminError('origin_not_allowed',403);
 if(request.headers.get('X-IPTV-Admin-Action')!==IDENTITY_OWNER_ACTION)return adminError('action_not_allowed',403);
 if(mcpMediaType(request.headers.get('Content-Type'))!=='application/json')return adminError('content_type_not_json',415);
 const access=await identityOwnerAccess(request,env);
 if(!access.ok)return adminError(access.code,access.status);
 const parsed=await identityOwnerBody(request);
 if(parsed.error)return adminError(parsed.error,400);
 const input=identityOwnerRequest(parsed.value);
 if(input.error)return adminError(input.error,400);
 if(typeof LetterboxdFacts==='undefined'||typeof WatchlistD1==='undefined')return adminError('reader_unavailable',503);
 const at=new Date().toISOString(),by=access.by;
 // ONE atomic commit (review of PR #1009): the shared check document (or the backlog) and the ledger rows of the SAME ids change in one D1 batch. The ledger rows are planned first (their tokens either come from the
 // request, for the Watchlist lane, or are read now), the write then carries them as `extra`; a moved document, a moved row or a store that cannot batch refuses everything and nothing is written.
 const plan=await WatchlistD1.ownerAdmissionPlan(env,{action:input.action,lids:input.lids,rows:input.rows});
 if(!plan.ok)return adminError(plan.reason==='shape'?'invalid_rows':'ledger_'+plan.reason,plan.reason==='shape'?400:503);
 try{
  const out=await LetterboxdFacts.ownerAction(env,{action:input.action,lids:input.lids,slugs:input.slugs,createMissing:input.lane==='diary_backlog',expectedVersion:input.version,by,why:input.why,at,extra:plan.statements});
  if(out.state==='stale_revision')return adminError('stale_revision',409);
  if(out.state==='check_in_flight')return json({error:'check_in_flight',committed:false,ids:out.ids},409);
  if(out.state==='backlog_full')return json({action:input.action,lane:input.lane,committed:false,results:out.results,backlogFull:true},409);
  // The readback of ALL THREE places and its proof: after `requeue` every named entry, backlog record and open ledger row is back at 0 attempts (a row `pending`); after `dismiss` no id is left in the backlog, every entry is
  // `owner_dismissed` and every touched row is terminal. An id may be named in any lane: the action covers every place that holds it.
  const ledger=await WatchlistD1.admissionRowsOf(env,input.lids).catch(()=>({ok:false}));
  const rows=ledger.ok?new Map(ledger.rows.map(row=>[row.lid,row])):null;
  const requeue=input.action==='requeue';
  const proven=rows?input.lids.every(lid=>{
   const entry=out.entries[lid],record=out.backlog[lid],row=rows.get(lid),touched=plan.tokens.some(token=>token.lid===lid);
   const entryOk=!entry||(requeue?entry.attempts===0:entry.reason==='owner_dismissed');
   const backlogOk=requeue?(!record||record.attempts===0):!record;
   const rowOk=!touched||(row&&(requeue?row.state==='pending'&&row.attempts===0:row.state==='terminal'&&row.lastReason==='owner_dismissed'));
   return entryOk&&backlogOk&&!!rowOk;
  }):null;
  return json({action:input.action,lane:input.lane,committed:true,results:out.results,skipped:plan.skipped,readback:{version:out.version,entries:out.entries,backlog:out.backlog,rows:ledger.ok?ledger.rows:null,proven}});
 }catch(error){
  if(error&&error.code==='atomic_unavailable')return adminError('atomic_unavailable',503);
  return adminError(typeof error?.code==='string'?error.code:'unavailable',503);
 }
}
