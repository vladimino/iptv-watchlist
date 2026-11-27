// AIR-634 (card PV3; ADR 0214 decisions 9, 11, 15-16 as amended by ADR 0224): the authenticated owner API of the per-field provenance of one Film's `film_metadata`. DORMANT: it refuses every write while the schema is absent
// or the control mode is `off`, and deploying it writes nothing (no migration, no mode change, no run, no Task).
//  GET  /api/admin/films/<id>/metadata   a PURE read (registered in the GET write baseline): each value with its field row, its effective rank and the language bound to it (ADR 0224), the locks, the Film's C1 state rows with
//                                         their conflicts and hints, the Films redirected into it (one hop) and the history, newest first, 50 rows per page, cursor `(at, id)`.
//  POST /api/admin/films/<id>/metadata   {action:'set'|'lock'|'release'|'revert'|'refresh', field?, value?, historyRef?, expectedRevision, expectedRows?, requestId}
// The Worker ITSELF verifies the Access JWT (signature, issuer, audience `ADMIN_ACCESS_AUD`, expiry, through the verifier `/mcp` uses) and the owner subject (`ADMIN_OWNER_EMAIL`), plus its own Origin, the action header and a JSON
// content type; unconfigured is closed. A metadata action is ONE `writeFilmFacts` batch with owner authority (the single writer owns every rule: locks, history, fences, the language bound to a value), compare-and-swap on
// `expectedRevision`, and the immutable `film_metadata_owner_command` row in the same batch. `refresh` is epoch-only (the C1 `core` rows and that command row; no metadata, no history, no Film revision bump).
// The command row is read BEFORE anything else: the same request id with the same digest answers `already_applied` from it, a different digest is `request_mismatch`, no row means the command has not committed yet.
// A rejection commits nothing and writes no row; an answer lost after the batch is `uncertain` (503, outcome unknown) and the same command may simply be sent again.
const FILM_META_ACTION='film_metadata_owner';
const FILM_META_REQUEST_ID=/^[A-Za-z0-9:._-]{8,100}$/;
const FILM_META_ACTIONS=['set','lock','release','revert','refresh'];
const FILM_META_KEYS=['action','field','value','historyRef','expectedRevision','expectedRows','requestId'];
const FILM_META_PAGE=50;
const FILM_META_C1_FILM_KEYS=['disagreement','fallbackFill','unconfirmedAgreement','storedDiffers','supersededKept','writtenFields','agreedAnchorDigest','anchorCheckedAt'];
const FILM_META_CURSOR=/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)~(\d{1,15})$/;
const FILM_META_REFRESHABLE=['complete','complete_with_gaps','due','needs_attention','deferred_repair'];
const FILM_META_CORE_SOURCES=['letterboxd','tmdb','wikidata'];
const filmMetaAbsent=error=>/no such table/i.test(String(error?.cause?.message||error?.message||error));
// the Film itself and every Film redirected into it (one hop): a relational condition, never a fixed list
const FILM_META_HISTORY_FILMS='film_id=? OR film_id IN (SELECT from_id FROM film_redirect WHERE to_film_id=?)';
const filmMetaParse=text=>{try{return JSON.parse(text);}catch{return null;}};

// ---- the path ----
function filmMetaPathId(url){
 const marker='/metadata';
 let id=url.pathname.slice('/api/admin/films/'.length);
 if(!id.endsWith(marker))return null;
 id=id.slice(0,-marker.length);
 try{id=decodeURIComponent(id);}catch{return null;}
 if(!id||id.length>200||id.includes('/'))return null;
 return id;
}

// ---- the request: pure validation, then the normalized digest ----
function filmMetaRows(rows){
 if(!Array.isArray(rows)||!rows.length||rows.length>10)return null;
 const out=rows.map(row=>row&&typeof row==='object'&&!Array.isArray(row)?{part:row.part,source:row.source,status:row.status,updatedAt:row.updatedAt,refreshEpoch:row.refreshEpoch}:null);
 if(out.some(row=>!row||row.part!=='core'||!FILM_META_CORE_SOURCES.includes(row.source)||typeof row.status!=='string'||!row.status||row.status.length>40||typeof row.updatedAt!=='string'||row.updatedAt.length!==24||!Number.isInteger(row.refreshEpoch)||row.refreshEpoch<0))return null;
 if(new Set(out.map(row=>row.source)).size!==out.length)return null;
 return out.sort((a,b)=>a.source<b.source?-1:1);
}
// ADR 0214 decision 9: the owner's value is typed before it is normalized. Numbers are JSON integers (or a digit string, as the normalizer agrees), text is a JSON string, genres a JSON array of strings.
function filmMetaRawValueOk(field,raw){
 if(field==='year'||field==='runtime')return Number.isInteger(raw)||(typeof raw==='string'&&/^\s*\d+\s*$/.test(raw));
 if(field==='genres')return Array.isArray(raw)&&raw.every(item=>typeof item==='string');
 return typeof raw==='string';
}
function filmMetaRequest(body){
 if(Object.keys(body).some(key=>!FILM_META_KEYS.includes(key)))return {error:'invalid_command'};
 const {action,field}=body;
 if(!FILM_META_ACTIONS.includes(action))return {error:'invalid_action'};
 if(typeof body.requestId!=='string'||!FILM_META_REQUEST_ID.test(body.requestId))return {error:'invalid_request_id'};
 if(!Number.isInteger(body.expectedRevision)||body.expectedRevision<0)return {error:'invalid_expected_revision'};
 const out={action,requestId:body.requestId,expectedRevision:body.expectedRevision,field:null,value:null,historyRef:null,expectedRows:null};
 if(action==='refresh'){
  if(Object.hasOwn(body,'field')||Object.hasOwn(body,'value')||Object.hasOwn(body,'historyRef'))return {error:'invalid_command'};
  out.expectedRows=filmMetaRows(body.expectedRows);
  if(!out.expectedRows)return {error:'invalid_expected_rows'};
  return out;
 }
 if(Object.hasOwn(body,'expectedRows'))return {error:'invalid_command'};
 if(!FilmMetadataProvenance.FIELDS.includes(field))return {error:'invalid_field'};
 out.field=field;
 if(action==='set'){
  if(!Object.hasOwn(body,'value')||Object.hasOwn(body,'historyRef'))return {error:'invalid_command'};
  // the raw JSON type first: the shared normalizer coerces any scalar or object to text, which must never become an owner pin
  if(!filmMetaRawValueOk(field,body.value))return {error:'invalid_value'};
  const value=FilmMetadataProvenance.normalizeValue(field,body.value);
  if(value===null)return {error:'invalid_value'};
  out.value=value;
 }else if(action==='revert'){
  if(Object.hasOwn(body,'value')||!Number.isInteger(body.historyRef)||body.historyRef<1)return {error:'invalid_history_ref'};
  out.historyRef=body.historyRef;
 }else if(Object.hasOwn(body,'value')||Object.hasOwn(body,'historyRef'))return {error:'invalid_command'};
 return out;
}
// SHA-256 of the normalized command (ADR 0214 decision 9): `filmId` as received, the action, the field, the canonical value, the history reference, the expected revision and, for a refresh, the sorted expected rows.
const filmMetaDigest=(filmId,command)=>FilmMetadataProvenance.sha256Hex(CatalogEnrichmentPlan.canonicalJson({filmId,action:command.action,field:command.field,value:command.value,historyRef:command.historyRef,expectedRevision:command.expectedRevision,expectedRows:command.expectedRows}));

// ---- the command record ----
async function filmMetaCommandRow(db,requestId){
 try{
  const row=await db.prepare('SELECT request_id,film_id,action,command_digest,outcome,applied_revision,at FROM film_metadata_owner_command WHERE request_id=?').bind(requestId).first();
  return {row:row||null};
 }catch(error){
  if(filmMetaAbsent(error))return {absent:true};
  throw error;
 }
}
const filmMetaCommandView=row=>({action:row.action,outcome:row.outcome,appliedRevision:row.applied_revision===null||row.applied_revision===undefined?null:Number(row.applied_revision),at:row.at});

// ---- the typed readback: a pure read ----
function filmMetaHistoryRow(row,digest){
 const value=row.old_value_text===null?null:filmMetaParse(row.old_value_text);
 let blocked=null;
 if(row.old_value_text===null)blocked='no_value';
 else if(row.old_anchor_digest===null)blocked='identity_unknown';
 else if(digest&&row.old_anchor_digest!==digest)blocked='anchor_changed';
 return {id:Number(row.id),filmId:row.film_id,field:row.field,reason:row.reason,at:row.at,writeKey:row.write_key,mergedFrom:row.merged_from,
  old:{value,tier:row.old_tier,source:row.old_source,anchorScheme:row.old_anchor_scheme,anchorValue:row.old_anchor_value,anchorDigest:row.old_anchor_digest,agreement:row.old_agreement,language:row.old_language,languageBasis:row.old_language_basis,observedAt:row.old_observed_at},
  new:{valueDigest:row.new_value_digest,tier:row.new_tier,source:row.new_source,language:row.new_language,languageBasis:row.new_language_basis,anchorDigest:row.new_anchor_digest},
  revertible:blocked===null,revertBlocked:blocked};
}
async function filmMetaRead(env,filmId,{history=null}={}){
 const db=env.DB;
 const snapshot=await CanonicalFilmWriters.readFilmSnapshot(env,filmId);
 if(!snapshot.film)return {found:false};
 const prov=snapshot.provenance;
 const out={found:true,filmId,revision:snapshot.revision,redirectedTo:snapshot.redirect,schemaAbsent:prov===null,mode:prov?prov.mode:null,controlRevision:prov?prov.revision:null};
 const dim=snapshot.dimensions.metadata,dimLocked=!!dim&&(dim.status==='reviewed'||dim.authority==='owner');
 out.dimensionLocked=dimLocked;
 const digest=prov&&prov.anchors?prov.anchors.digest:null;
 out.anchorDigest=digest;
 out.disagreement=prov?prov.disagreement:false;
 out.fields={};
 for(const field of FilmMetadataProvenance.FIELDS){
  const value=FilmMetadataProvenance.storedValue(snapshot.metadata,field);
  const row=prov&&prov.fields?prov.fields[field]||null:null;
  const entry={value,blank:value===null};
  if(prov&&prov.mode!=='off'){
   const stand=FilmMetadataProvenance.confidenceOf(row,value,digest,dimLocked);
   entry.rank={name:stand.name,value:stand.rank};
   entry.bound=stand.bound;entry.mismatch=stand.mismatch;
   entry.locked=stand.name==='owner';
   entry.row=row?{tier:row.tier,source:row.source,origin:row.origin,anchorScheme:row.anchor_scheme,anchorValue:row.anchor_value,anchorDigest:row.anchor_digest,agreement:row.agreement,language:row.language,languageBasis:row.language_basis,observedAt:row.observed_at,checkedAt:row.checked_at,writeKey:row.write_key,writtenRevision:Number(row.written_revision)}:null;
  }
  out.fields[field]=entry;
 }
 out.locks={owner:Object.entries(out.fields).filter(([,item])=>item.row&&item.row.tier==='owner').map(([field])=>field),dimension:dimLocked};
 // the Film's C1 state, read directly and completely: the Film row, the core and localization rows (at most one per source, slot 0: a fixed, small set) and an aggregate of the credits chunks, which are not capped per Film
 try{
  const fixed=(await db.prepare("SELECT part,source,slot,status,reason,updated_at,refresh_epoch,plan_epoch,gaps_json,conflicts_json,hints_json,film_json FROM catalog_enrichment_state WHERE film_id=? AND part IN ('film','core','localization') ORDER BY part,source").bind(filmId).all()).results||[];
  const credits=(await db.prepare("SELECT status,COUNT(*) AS n,SUM(CASE WHEN conflicts_json IS NOT NULL THEN 1 ELSE 0 END) AS conflicts FROM catalog_enrichment_state WHERE film_id=? AND part='credits' GROUP BY status").bind(filmId).all()).results||[];
  const view=row=>({part:row.part,source:row.source,slot:Number(row.slot),status:row.status,reason:row.reason,updatedAt:row.updated_at,refreshEpoch:Number(row.refresh_epoch),planEpoch:Number(row.plan_epoch)});
  const filmRow=fixed.find(row=>row.part==='film');
  const filmJson=filmRow&&filmRow.film_json?filmMetaParse(filmRow.film_json):null;
  const detail={};
  if(filmJson&&typeof filmJson==='object')for(const key of FILM_META_C1_FILM_KEYS)if(filmJson[key]!==undefined)detail[key]=filmJson[key];
  const parts=fixed.filter(row=>row.part!=='film');
  out.c1={
   rows:fixed.map(view),
   film:filmRow?{...view(filmRow),...detail}:null,
   conflicts:parts.filter(row=>row.conflicts_json).map(row=>({part:row.part,source:row.source,value:filmMetaParse(row.conflicts_json)})),
   hints:parts.filter(row=>row.hints_json).map(row=>({part:row.part,source:row.source,value:filmMetaParse(row.hints_json)})),
   gaps:parts.filter(row=>row.gaps_json).map(row=>({part:row.part,source:row.source,value:filmMetaParse(row.gaps_json)})),
   credits:{chunks:credits.reduce((sum,row)=>sum+Number(row.n),0),withConflicts:credits.reduce((sum,row)=>sum+Number(row.conflicts||0),0),byStatus:Object.fromEntries(credits.map(row=>[row.status,Number(row.n)]))},
  };
 }catch(error){if(!filmMetaAbsent(error))throw error;out.c1=null;}
 if(history===null)return out;
 // redirect history: ALL one-hop predecessors, through the target index of `film_redirect`, in one keyset page. A page returns at most 50 rows whatever the number of predecessors; no predecessor is left out.
 out.redirects={count:Number((await db.prepare('SELECT COUNT(*) AS n FROM film_redirect WHERE to_film_id=?').bind(filmId).first())?.n??0)};
 let page={rows:[],next:null};
 if(prov){
  const cursor=history.cursor?FILM_META_CURSOR.exec(history.cursor):null;
  let rows=[];
  try{rows=(await db.prepare('SELECT id,film_id,field,reason,old_value_text,old_tier,old_source,old_anchor_scheme,old_anchor_value,old_anchor_digest,old_agreement,old_language,old_language_basis,old_observed_at,new_value_digest,new_tier,new_source,new_language,new_language_basis,new_anchor_digest,write_key,at,merged_from FROM film_metadata_history WHERE ('+FILM_META_HISTORY_FILMS+')'+(cursor?' AND (at<? OR (at=? AND id<?))':'')+' ORDER BY at DESC,id DESC LIMIT ?').bind(filmId,filmId,...(cursor?[cursor[1],cursor[1],Number(cursor[2])]:[]),FILM_META_PAGE+1).all()).results||[];}
  catch(error){if(!filmMetaAbsent(error))throw error;}
  const more=rows.length>FILM_META_PAGE;
  rows=rows.slice(0,FILM_META_PAGE);
  page={rows:rows.map(row=>filmMetaHistoryRow(row,digest)),next:more?rows[rows.length-1].at+'~'+rows[rows.length-1].id:null};
 }
 out.history=page;
 return out;
}

// ---- the write ----
function filmMetaFailure(error){
 const code=error?.code;
 if(code==='film_metadata_rejected'){
  const first=(error.rejected||[])[0]||{};
  return {status:409,body:{error:first.reason||'rejected',outcome:'rejected',rejected:error.rejected||[]}};
 }
 if(code==='film_person_invalid')return {status:400,body:{error:'invalid_command',outcome:'rejected'}};
 if(code==='film_person_revision_conflict')return {status:409,body:{error:'stale_revision',outcome:'rejected'}};
 if(code==='film_person_redirect')return {status:409,body:{error:'redirected',outcome:'rejected'}};
 if(code==='film_person_held'||code==='film_person_not_open'||code==='film_person_fence')return {status:409,body:{error:'authority_not_open',outcome:'rejected'}};
 if(code==='film_person_bounded')return {status:409,body:{error:'bounded',outcome:'rejected'}};
 if(code==='film_person_precondition')return {status:409,body:{error:'precondition_failed',outcome:'rejected',recovery:'Reload the Film and plan the command again.'}};
 return null;
}
const filmMetaUncertain=()=>({status:503,body:{error:'storage_unavailable',outcome:'unknown',recovery:'Read the Film again, or send the same command again: the request id settles it.'}});
const filmMetaAnswered=(filmId,command,row,readback)=>({status:200,body:{ok:true,outcome:'already_applied',action:command.action,requestId:command.requestId,filmId,command:filmMetaCommandView(row),...(readback?{readback}:{})}});

async function filmMetaRefresh(env,filmId,command,digest,at){
 const db=env.DB;
 // the core rows (at most one per source) are the only rows a refresh compares; any state row at all puts the Film in scope
 const stored=(await db.prepare("SELECT part,source,slot,status,updated_at,refresh_epoch,plan_epoch FROM catalog_enrichment_state WHERE film_id=? AND part='core' AND slot=0").bind(filmId).all()).results||[];
 if(!stored.length&&!(await db.prepare('SELECT 1 AS present FROM catalog_enrichment_state WHERE film_id=? LIMIT 1').bind(filmId).first()))return {status:409,body:{error:'not_in_scope',outcome:'rejected'}};
 const core=new Map(stored.map(row=>[row.source,row]));
 for(const row of command.expectedRows){
  const current=core.get(row.source);
  if(!current||current.status!==row.status||current.updated_at!==row.updatedAt||Number(current.refresh_epoch)!==row.refreshEpoch)return {status:409,body:{error:'stale_rows',outcome:'rejected',filmId,current:stored.map(item=>({part:item.part,source:item.source,slot:Number(item.slot),status:item.status,updatedAt:item.updated_at,refreshEpoch:Number(item.refresh_epoch)}))}};
 }
 const targets=command.expectedRows.filter(row=>FILM_META_REFRESHABLE.includes(row.status));
 if(!targets.length)return {status:409,body:{error:'not_refreshable',outcome:'rejected'}};
 const control=await FilmMetadataProvenance.readControl(db);
 const gate=CanonicalMutations.fenced.bindProducerFence(env,FilmPersonAuthority.assertWritable(await FilmPersonAuthority.readAuthority(env)));
 let generation=0;
 try{generation=Number((await db.prepare('SELECT generation FROM catalog_enrichment_control WHERE id=1').first())?.generation??0);}catch(error){if(!filmMetaAbsent(error))throw error;}
 const fenced=CanonicalMutations.fenced,entities=[{kind:'film',id:filmId,expected:command.expectedRevision}];
 const statements=fenced.head(gate,entities);
 // the mode and revision the route planned under (a switch to `off` is impossible, a `hold` is allowed), the Film, and the ADR 0211 control generation
 statements.push([fenced.assertSql("EXISTS (SELECT 1 FROM film_metadata_provenance_control WHERE id=1 AND mode<>'off' AND mode=? AND revision=?)"),[control.mode,control.revision]]);
 statements.push([fenced.assertSql('EXISTS (SELECT 1 FROM film WHERE id=?) AND NOT EXISTS (SELECT 1 FROM film_redirect WHERE from_id=?)'),[filmId,filmId]]);
 statements.push([fenced.assertSql('COALESCE((SELECT generation FROM catalog_enrichment_control WHERE id=1),0)=?'),[generation]]);
 // ONE assertion over every row the owner saw (status, updated_at and epoch), so a moved or leased row rolls the whole batch back
 const seen=JSON.stringify(command.expectedRows.map(row=>({source:row.source,status:row.status,updatedAt:row.updatedAt,epoch:row.refreshEpoch})));
 statements.push([fenced.assertSql("NOT EXISTS (SELECT 1 FROM json_each(?) j WHERE NOT EXISTS (SELECT 1 FROM catalog_enrichment_state s WHERE s.film_id=? AND s.part='core' AND s.slot=0 AND s.source=json_extract(j.value,'$.source') AND s.status=json_extract(j.value,'$.status') AND s.updated_at=json_extract(j.value,'$.updatedAt') AND s.refresh_epoch=json_extract(j.value,'$.epoch')))"),[seen,filmId]]);
 for(const row of targets)statements.push(["UPDATE catalog_enrichment_state SET status='due',reason=NULL,failures=0,transport_streak=0,failure_class=NULL,pending_since=NULL,retry_at=NULL,refresh_epoch=refresh_epoch+1,updated_at=? WHERE film_id=? AND part='core' AND source=? AND slot=0 AND status=? AND updated_at=? AND refresh_epoch=?",[at,filmId,row.source,row.status,row.updatedAt,row.refreshEpoch]]);
 // every batch of an older plan of this Film fails on the raised plan epoch
 statements.push(["UPDATE catalog_enrichment_state SET plan_epoch=plan_epoch+1,updated_at=? WHERE film_id=? AND part='film' AND source='*'",[at,filmId]]);
 statements.push([fenced.assertSql('changes()>=1'),[]]);
 statements.push(['INSERT INTO film_metadata_owner_command (request_id,film_id,action,command_digest,outcome,applied_revision,at) VALUES (?,?,?,?,?,NULL,?)',[command.requestId,filmId,'refresh',digest,'applied',at]]);
 await fenced.commit(env,gate,statements,entities);
 return null;
}

async function filmMetaApply(env,filmId,command,digest,at){
 const snapshot=await CanonicalFilmWriters.readFilmSnapshot(env,filmId);
 if(!snapshot.film)return {status:404,body:{error:'not_found',outcome:'rejected'}};
 if(snapshot.redirect)return {status:409,body:{error:'redirected',outcome:'rejected',redirectedTo:snapshot.redirect}};
 if(snapshot.revision!==command.expectedRevision)return {status:409,body:{error:'stale_revision',outcome:'rejected',revision:snapshot.revision}};
 const owner={action:command.action,field:command.field};
 if(command.action==='set')owner.value=command.value;
 if(command.action==='revert'){
  const row=await env.DB.prepare('SELECT id,film_id,field,old_value_text,old_source,old_anchor_scheme,old_anchor_value,old_anchor_digest,old_language,old_language_basis,old_observed_at FROM film_metadata_history WHERE id=?').bind(command.historyRef).first();
  if(!row)return {status:404,body:{error:'history_not_found',outcome:'rejected'}};
  if(row.field!==command.field||row.old_value_text===null)return {status:400,body:{error:'invalid_history_ref',outcome:'rejected'}};
  const own=row.film_id===filmId||!!(await env.DB.prepare('SELECT 1 AS present FROM film_redirect WHERE from_id=? AND to_film_id=?').bind(row.film_id,filmId).first());
  if(!own)return {status:409,body:{error:'foreign_history',outcome:'rejected'}};
  owner.history={id:Number(row.id),field:row.field,oldValueText:row.old_value_text,oldSource:row.old_source,oldAnchorScheme:row.old_anchor_scheme,oldAnchorValue:row.old_anchor_value,oldAnchorDigest:row.old_anchor_digest,oldLanguage:row.old_language,oldLanguageBasis:row.old_language_basis,oldObservedAt:row.old_observed_at};
 }
 const written=await CanonicalFilmWriters.writeFilmFacts(env,{id:filmId,at,requestId:command.requestId,expectedRevision:command.expectedRevision,film:{contractVersion:1},metadata:{updatedAt:at,ownerActions:[owner]},metadataAuthority:{authority:'owner',origin:'owner_route'},requireExisting:true,ownerCommand:{requestId:command.requestId,action:command.action,digest}});
 return written?null:{status:500,body:{error:'unexpected'}};
}

async function filmMetaWrite(request,env,url,filmId){
 if(request.headers.get('Origin')!==url.origin)return adminError('origin_not_allowed',403);
 if(request.headers.get('X-IPTV-Admin-Action')!==FILM_META_ACTION)return adminError('action_not_allowed',403);
 if(mcpMediaType(request.headers.get('Content-Type'))!=='application/json')return adminError('content_type_not_json',415);
 const access=await identityOwnerAccess(request,env);
 if(!access.ok)return adminError(access.code,access.status);
 const parsed=await identityOwnerBody(request);
 if(parsed.error)return adminError(parsed.error,400);
 const command=filmMetaRequest(parsed.value);
 if(command.error)return adminError(command.error,400);
 if(!env.DB)return adminError('unavailable',503);
 const digest=filmMetaDigest(filmId,command);
 // 1. the command row, before anything else
 let recorded;
 try{recorded=await filmMetaCommandRow(env.DB,command.requestId);}catch{return json({error:'storage_unavailable',outcome:'unknown'},503);}
 if(recorded.absent)return json({error:'schema_absent',outcome:'rejected'},409);
 const answer=async row=>{
  if(row.command_digest!==digest)return json({error:'request_mismatch',outcome:'rejected',requestId:command.requestId},409);
  let readback=null;try{readback=await filmMetaRead(env,filmId);}catch{readback=null;}
  const made=filmMetaAnswered(filmId,command,row,readback&&readback.found?readback:null);
  return json(made.body,made.status);
 };
 if(recorded.row)return answer(recorded.row);
 // 2. the mode: schema absent and `off` refuse every write
 let control;
 try{control=await FilmMetadataProvenance.readControl(env.DB);}catch{return json({error:'storage_unavailable',outcome:'unknown'},503);}
 if(control===null)return json({error:'schema_absent',outcome:'rejected'},409);
 if(control.mode==='off')return json({error:'provenance_off',outcome:'rejected'},409);
 // 3. the effect, one batch. EVERY refusal that follows the first (empty) receipt read, a pre-batch one included, is reconciled against the receipt before it is answered: a concurrent attempt may have committed this very command in between
 const at=new Date().toISOString();
 let refusal=null,thrown=null;
 try{refusal=command.action==='refresh'?await filmMetaRefresh(env,filmId,command,digest,at):await filmMetaApply(env,filmId,command,digest,at);}
 catch(error){thrown=error;}
 if(refusal||thrown){
  let again=null;try{again=await filmMetaCommandRow(env.DB,command.requestId);}catch{again=null;}
  if(again&&again.row)return answer(again.row); // same digest: already_applied; another digest: request_mismatch; whatever the Film is now (redirected or merged included)
  // an unreadable receipt cannot tell a definite refusal from a lost commit: nothing is decided, the same command may simply be sent again
  if(!again){const unknown=filmMetaUncertain();return json(unknown.body,unknown.status);}
  if(refusal)return json(refusal.body,refusal.status);
  const error=thrown;
  // a revert whose anchor set moved between the plan and the commit fails the batch on the anchor guard: name it for what it is
  if(command.action==='revert'&&error?.code==='film_person_precondition'){
   try{
    const now=await CanonicalFilmWriters.readFilmSnapshot(env,filmId),old=await env.DB.prepare('SELECT old_anchor_digest FROM film_metadata_history WHERE id=?').bind(command.historyRef).first();
    if(old&&now.provenance&&now.provenance.anchors&&old.old_anchor_digest!==now.provenance.anchors.digest)return json({error:'anchor_changed',outcome:'rejected'},409);
   }catch{/* the generic answer below still holds */}
  }
  const mapped=filmMetaFailure(error);
  if(mapped)return json(mapped.body,mapped.status);
  const unknown=filmMetaUncertain();
  return json(unknown.body,unknown.status);
 }
 // 4. the readback: the command row of THIS command proves the commit
 let stored;
 try{stored=await filmMetaCommandRow(env.DB,command.requestId);}catch{stored=null;}
 if(!stored||!stored.row||stored.row.command_digest!==digest){const unknown=filmMetaUncertain();return json(unknown.body,unknown.status);}
 if(command.action==='refresh'&&typeof CatalogEnrichmentRunner!=='undefined'){try{await CatalogEnrichmentRunner.kick(env);}catch{/* a lost wake is recovered by the producer's own reconcile */}}
 let readback=null;try{readback=await filmMetaRead(env,filmId);}catch{readback=null;}
 return json({ok:true,outcome:stored.row.outcome,action:command.action,requestId:command.requestId,filmId,command:filmMetaCommandView(stored.row),...(readback&&readback.found?{readback}:{})});
}

async function adminFilmMetadataRoute(request,env,url){
 const filmId=filmMetaPathId(url);
 if(filmId===null)return adminError('not_found',404);
 if(request.method==='GET'||request.method==='HEAD'){
  if(!env.DB)return adminError('unavailable',503);
  const cursor=url.searchParams.get('cursor');
  if(cursor!==null&&!FILM_META_CURSOR.test(cursor))return adminError('invalid_cursor',400);
  try{
   const view=await filmMetaRead(env,filmId,{history:{cursor}});
   return view.found?json(view):json({error:'not_found'},404);
  }catch(error){
   if(error?.code==='film_person_invalid')return adminError('not_found',404);
   return adminError('unavailable',503);
  }
 }
 if(request.method!=='POST')return adminError('method_not_allowed',405);
 return filmMetaWrite(request,env,url,filmId);
}
