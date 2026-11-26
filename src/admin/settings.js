// AIR-605 (card C1; ADR 0211 decision 6 as amended by ADR 0219): the authenticated control and readback of the Catalog Enrichment Producer. DORMANT: the producer is inactive without a control row, and the routes only read it or move it
// between active and paused. NOT the page: `/admin/settings` (the checkbox UI) is card CU. Activation is an owner production operation (card C2) and is NOT reachable from here.
//  GET  /api/admin/settings                         the EFFECTIVE state, a pure read (registered in the GET write baseline): control, the last run, whether a run is still draining after a pause, counts, active upstream cooldowns,
//                                                   the Films in `identity_disagreement` or with a part in `needs_attention` / `deferred_repair`, with the lists the producer keeps for owner review.
//  POST /api/admin/settings/catalog-enrichment      {action:'pause'|'resume', expectedRevision, requestId}  or  {action:'retry', filmId, part?, source?, expectedRows, requestId}
// The Worker ITSELF verifies the Access JWT (signature, issuer, audience `ADMIN_ACCESS_AUD`, expiry, through the verifier `/mcp` uses) and the owner (`ADMIN_OWNER_EMAIL`), plus its own Origin, the action header and a JSON
// content type; unconfigured is closed (503). Pause and resume are ONE compare-and-swap on the control row's `revision` through the store's own function, and the answer is a READBACK: `applied`, `rejected` (409, the current
// state) or `uncertain` (503 with `outcome: unknown`, as the channel policy import). A retry has its own compare-and-swap on the state rows the owner saw (`expectedRows`: status and updated_at per row), never changes the
// control revision (so it cannot race pause or resume), resets the selected rows to `due`, raises `refresh_epoch` and the Film's `plan_epoch` (every batch of an older plan fails), keeps `due_since` and writes no metadata.
// It starts no run, no check and no Task.
const CATALOG_ENRICHMENT_SETTINGS_ACTION='catalog_enrichment_settings';
const CATALOG_ENRICHMENT_ATTENTION_LIMIT=50;
const CATALOG_ENRICHMENT_REQUEST_ID=/^[A-Za-z0-9:._-]{8,100}$/;
const CATALOG_ENRICHMENT_PARTS=['core','credits','localization'];
const CATALOG_ENRICHMENT_SOURCES=['letterboxd','tmdb','wikidata'];
const catalogAbsentTable=error=>/no such table/i.test(String(error?.cause?.message||error?.message||error));

// ---- the effective state: a pure read ----
async function catalogEnrichmentEffective(env){
 const db=env.DB;
 if(!db)return {configured:false,reason:'no_database'};
 const first=async(sql,params=[])=>(await db.prepare(sql).bind(...params).first())||null;
 const all=async(sql,params=[])=>(await db.prepare(sql).bind(...params).all()).results||[];
 let control;
 try{control=await first('SELECT state,generation,revision,updated_at,updated_by FROM catalog_enrichment_control WHERE id=1');}
 catch(error){if(catalogAbsentTable(error))return {configured:false,reason:'schema_missing',state:'inactive'};throw error;}
 const out={configured:true,control:control?{state:control.state,generation:Number(control.generation),revision:Number(control.revision),updatedAt:control.updated_at,updatedBy:control.updated_by}:{state:'inactive',generation:0,revision:0,updatedAt:null,updatedBy:null}};
 out.scopes=(await all('SELECT scope,activated,enabled,cutoff_at,bootstrap_state,revision FROM catalog_enrichment_scope ORDER BY scope')).map(row=>({scope:row.scope,activated:!!row.activated,enabled:!!row.enabled,cutoffAt:row.cutoff_at,bootstrapState:row.bootstrap_state,revision:Number(row.revision)}));
 const tick=await first('SELECT tick_id,started_at,finished_at,state,counts_json FROM catalog_enrichment_tick ORDER BY started_at DESC LIMIT 1');
 out.lastRun=tick?{tickId:tick.tick_id,startedAt:tick.started_at,finishedAt:tick.finished_at,state:tick.state,counts:(()=>{try{return JSON.parse(tick.counts_json);}catch{return null;}})()}:null;
 // after a pause a run may still be draining: its entry has not been written as stopped, and its lease is live
 const lease=await first("SELECT lease_id,lease_until FROM projection_run WHERE projection='catalog_enrichment' AND lease_id IS NOT NULL").catch(()=>null);
 out.draining=out.control.state==='paused'&&!!out.lastRun&&out.lastRun.state==='started'?{leaseUntil:lease?.lease_until??null}:null;
 out.signals=await first("SELECT COUNT(*) AS pending,MIN(armed_at) AS oldest FROM enrichment_signal WHERE state='pending'").then(row=>({pending:Number(row?.pending??0),oldestArmedAt:row?.oldest??null})).catch(()=>null);
 out.due=await first("SELECT COUNT(DISTINCT film_id) AS films,MIN(due_since) AS oldest FROM catalog_enrichment_state WHERE part<>'film' AND status IN ('due','deferred_repair')").then(row=>({films:Number(row?.films??0),oldestDueSince:row?.oldest??null})).catch(()=>null);
 out.cooldowns=await all('SELECT scope,until_at,reason FROM upstream_cooldown ORDER BY scope').then(rows=>rows.map(row=>({scope:row.scope,untilAt:Number(row.until_at),reason:row.reason}))).catch(()=>[]);
 const attention=await all(`SELECT film_id,part,source,slot,status,reason,failure_class,failure_signature,failures,transport_streak,pending_since,retry_at,updated_at,film_json FROM catalog_enrichment_state WHERE status IN ('identity_disagreement','needs_attention','deferred_repair') ORDER BY updated_at DESC,film_id LIMIT ?`,[CATALOG_ENRICHMENT_ATTENTION_LIMIT+1]).catch(()=>[]);
 out.attention=attention.slice(0,CATALOG_ENRICHMENT_ATTENTION_LIMIT).map(row=>{
  let film=null;try{film=row.film_json?JSON.parse(row.film_json):null;}catch{film=null;}
  return {filmId:row.film_id,part:row.part,source:row.source,slot:Number(row.slot),status:row.status,reason:row.reason,failureClass:row.failure_class,failureSignature:row.failure_signature,failures:Number(row.failures),transportStreak:Number(row.transport_streak),pendingSince:row.pending_since,retryAt:row.retry_at,updatedAt:row.updated_at,
   lists:film?{fallbackFill:film.fallbackFill||[],unconfirmedAgreement:film.unconfirmedAgreement||[],writtenUnderSupersededAnchor:film.writtenUnderSupersededAnchor||[],disagreement:film.disagreement||null}:null,retry:{action:'retry',filmId:row.film_id,part:row.part==='film'?undefined:row.part,source:row.source==='*'?undefined:row.source}};
 });
 out.attentionTruncated=attention.length>CATALOG_ENRICHMENT_ATTENTION_LIMIT;
 return out;
}

// ---- the writes ----
function catalogEnrichmentRequest(body){
 const action=body.action;
 if(!['pause','resume','retry'].includes(action))return {error:'invalid_action'};
 if(typeof body.requestId!=='string'||!CATALOG_ENRICHMENT_REQUEST_ID.test(body.requestId))return {error:'invalid_request_id'};
 if(action!=='retry'){
  if(!Number.isInteger(body.expectedRevision)||body.expectedRevision<0)return {error:'invalid_expected_revision'};
  const extra=Object.keys(body).filter(key=>!['action','expectedRevision','requestId'].includes(key));
  return extra.length?{error:'unknown_field'}:{action,expectedRevision:body.expectedRevision,requestId:body.requestId};
 }
 if(typeof body.filmId!=='string'||!/^film:[A-Za-z0-9:._-]{1,190}$/.test(body.filmId))return {error:'invalid_film'};
 if(body.part!==undefined&&!CATALOG_ENRICHMENT_PARTS.includes(body.part))return {error:'invalid_part'};
 if(body.source!==undefined&&!CATALOG_ENRICHMENT_SOURCES.includes(body.source))return {error:'invalid_source'};
 if(!Array.isArray(body.expectedRows)||!body.expectedRows.length||body.expectedRows.length>60)return {error:'invalid_expected_rows'};
 const rows=body.expectedRows.map(row=>({part:row?.part,source:row?.source,slot:Number.isInteger(row?.slot)?row.slot:0,status:row?.status,updatedAt:row?.updatedAt}));
 if(rows.some(row=>!['film',...CATALOG_ENRICHMENT_PARTS].includes(row.part)||!['*',...CATALOG_ENRICHMENT_SOURCES].includes(row.source)||typeof row.status!=='string'||typeof row.updatedAt!=='string'||row.updatedAt.length!==24))return {error:'invalid_expected_rows'};
 const extra=Object.keys(body).filter(key=>!['action','filmId','part','source','expectedRows','requestId'].includes(key));
 return extra.length?{error:'unknown_field'}:{action,filmId:body.filmId,part:body.part,source:body.source,expectedRows:rows,requestId:body.requestId};
}
// The owner retry of rows the owner saw. Each selected row is matched on its status and updated_at; a moved row refuses the whole request before anything is written.
async function catalogEnrichmentRetry(env,input,by,at){
 const db=env.DB;
 const stored=(await db.prepare('SELECT part,source,slot,status,updated_at,refresh_epoch,plan_epoch FROM catalog_enrichment_state WHERE film_id=?').bind(input.filmId).all()).results||[];
 const keyOf=row=>[row.part,row.source,Number(row.slot||0)].join('|');
 const byKey=new Map(stored.map(row=>[keyOf(row),row]));
 const selected=input.expectedRows.filter(row=>(input.part===undefined||row.part===input.part||row.part==='film')&&(input.source===undefined||row.source===input.source||row.source==='*'));
 if(!selected.length)return {status:409,body:{error:'stale_rows',outcome:'rejected'}};
 for(const row of selected){
  const current=byKey.get(keyOf(row));
  if(!current||current.status!==row.status||current.updated_at!==row.updatedAt)return {status:409,body:{error:'stale_rows',outcome:'rejected',filmId:input.filmId,current:stored.map(item=>({part:item.part,source:item.source,slot:Number(item.slot),status:item.status,updatedAt:item.updated_at}))}};
 }
 const retryable=['needs_attention','deferred_repair','identity_disagreement'];
 const targets=selected.filter(row=>retryable.includes(row.status));
 if(!targets.length)return {status:409,body:{error:'nothing_to_retry',outcome:'rejected'}};
 const statements=[];
 for(const row of targets){
  if(row.part==='film')statements.push(db.prepare("UPDATE catalog_enrichment_state SET status='active',reason='check_anchors',plan_epoch=plan_epoch+1,updated_at=?,film_json=json_set(COALESCE(film_json,'{}'),'$.disagreement',json('null')) WHERE film_id=? AND part='film' AND source='*' AND status=? AND updated_at=?").bind(at,input.filmId,row.status,row.updatedAt));
  else statements.push(db.prepare("UPDATE catalog_enrichment_state SET status='due',reason=NULL,failures=0,transport_streak=0,failure_class=NULL,pending_since=NULL,retry_at=NULL,expected_json=CASE WHEN part='credits' THEN NULL ELSE expected_json END,refresh_epoch=refresh_epoch+1,updated_at=? WHERE film_id=? AND part=? AND source=? AND slot=? AND status=? AND updated_at=?").bind(at,input.filmId,row.part,row.source,row.slot,row.status,row.updatedAt));
 }
 // every selected part's Film also raises its plan epoch, so every batch of an older plan fails even with unchanged anchors
 if(!targets.some(row=>row.part==='film'))statements.push(db.prepare("UPDATE catalog_enrichment_state SET plan_epoch=plan_epoch+1,updated_at=? WHERE film_id=? AND part='film' AND source='*'").bind(at,input.filmId));
 try{await db.batch(statements);}catch{return {status:503,body:{error:'storage_unavailable',outcome:'unknown',recovery:'Reload the state: the retry may or may not have been stored.'}};}
 let after;
 try{after=(await db.prepare('SELECT part,source,slot,status,updated_at,refresh_epoch,plan_epoch FROM catalog_enrichment_state WHERE film_id=?').bind(input.filmId).all()).results||[];}
 catch{return {status:503,body:{error:'readback_failed',outcome:'unknown',recovery:'Reload the state to see whether the retry was stored.'}};}
 const proven=targets.every(row=>{
  const now=after.find(item=>keyOf(item)===keyOf(row)),before=byKey.get(keyOf(row));
  return row.part==='film'?now&&now.status==='active'&&Number(now.plan_epoch)>Number(before.plan_epoch):now&&now.status==='due'&&Number(now.refresh_epoch)>Number(before.refresh_epoch);
 });
 if(!proven)return {status:409,body:{error:'rows_changed',outcome:'rejected',filmId:input.filmId,current:after.map(item=>({part:item.part,source:item.source,slot:Number(item.slot),status:item.status,updatedAt:item.updated_at}))}};
 return {status:200,body:{ok:true,outcome:'applied',action:'retry',requestId:input.requestId,filmId:input.filmId,retried:targets.map(row=>({part:row.part,source:row.source,slot:row.slot})),readback:after.map(item=>({part:item.part,source:item.source,slot:Number(item.slot),status:item.status,updatedAt:item.updated_at}))}};
}

// Best-effort wake AFTER a successful owner action commits (never inside a transaction, never blocking the answer): a resume or a retry makes work runnable, and an uncertain outcome is recovered by the same kick.
async function catalogEnrichmentWake(env){
 if(typeof CatalogEnrichmentRunner==='undefined')return null;
 try{return await CatalogEnrichmentRunner.kick(env);}catch{return null;}
}

async function adminSettingsRoute(request,env,url){
 if(url.pathname==='/api/admin/settings'){
  if(request.method!=='GET'&&request.method!=='HEAD')return adminError('method_not_allowed',405);
  try{return json(await catalogEnrichmentEffective(env));}catch{return adminError('unavailable',503);}
 }
 if(url.pathname!=='/api/admin/settings/catalog-enrichment')return adminError('not_found',404);
 if(request.method!=='POST')return adminError('method_not_allowed',405);
 if(request.headers.get('Origin')!==url.origin)return adminError('origin_not_allowed',403);
 if(request.headers.get('X-IPTV-Admin-Action')!==CATALOG_ENRICHMENT_SETTINGS_ACTION)return adminError('action_not_allowed',403);
 if(mcpMediaType(request.headers.get('Content-Type'))!=='application/json')return adminError('content_type_not_json',415);
 const access=await identityOwnerAccess(request,env);
 if(!access.ok)return adminError(access.code,access.status);
 const parsed=await identityOwnerBody(request);
 if(parsed.error)return adminError(parsed.error,400);
 const input=catalogEnrichmentRequest(parsed.value);
 if(input.error)return adminError(input.error,400);
 if(!env.DB)return adminError('unavailable',503);
 const at=new Date().toISOString(),by=access.by;
 if(input.action==='retry'){const outcome=await catalogEnrichmentRetry(env,input,by,at);if(outcome.status===200||outcome.body?.outcome==='unknown')await catalogEnrichmentWake(env);return json(outcome.body,outcome.status);}
 if(typeof CatalogEnrichmentStore==='undefined')return adminError('control_unavailable',503);
 let result;
 try{result=await CatalogEnrichmentStore.changeControl(env,{action:input.action,expectedRevision:input.expectedRevision,by,at});}
 catch(error){
  if(error?.code==='catalog_enrichment_schema_missing')return adminError('schema_missing',503);
  return json({error:'storage_unavailable',outcome:'unknown',recovery:'Reload the state: the change may or may not have been stored.'},503);
 }
 if(result.outcome==='uncertain'){if(input.action==='resume')await catalogEnrichmentWake(env);return json({error:'readback_failed',outcome:'unknown',recovery:'Reload the state to see whether the change was stored.'},503);}
 if(result.outcome==='rejected')return json({ok:false,outcome:'rejected',action:input.action,requestId:input.requestId,control:result.control},409);
 if(input.action==='resume')await catalogEnrichmentWake(env);
 return json({ok:true,outcome:'applied',action:input.action,requestId:input.requestId,control:result.control});
}
