// Owner-only Channel admin API (AIR-562, ADR 0187), behind the same Cloudflare Access application as every /api/admin route.
//   GET  /api/admin/channels                 the staged Channel snapshot: list, filters, unclassified queue, categories, revision. Reads D1 only.
//   POST /api/admin/channels/preview         the diff an import of a normalized playlist would make. Writes nothing.
//   POST /api/admin/channels/import          one confirmed import (replaces provider classification and category policies). Never deletes a channel.
//   POST /api/admin/channels/override        sets or clears the owner policy override of one known channel.
//   POST /api/admin/channels/category        assigns or clears the owner category of one known channel.
// The browser parses the playlist; this route only ever receives normalized {sourceId,name,group} entries, never a stream URL, a token or the raw file, and it
// re-validates them (EpgChannelAdmin.validateSubmission, then the repository's planImport). Writes need the same-origin header, the admin action header, a JSON body,
// an explicit confirm:true and the revision the caller read (compare-and-swap in the repository). Every D1 access fails closed: a missing or incomplete schema 32
// answers 503 (GET: available:false when the tables are absent) and nothing is created, migrated or imported implicitly.
// Since AIR-565 (ADR 0198) every EPG scan reads this policy unconditionally (the retired EPG_CHANNEL_POLICY switch no longer exists); a saved change applies to the next natural EPG generation. A save or an
// import never starts EPG sync, Discovery, TMDB or any task.
const CHANNEL_ACTION='epg_channel_admin';
const CHANNEL_PAGE_DEFAULT=50,CHANNEL_PAGE_MAX=200;
const CHANNEL_ACTIVATION={state:'active',note:'Every EPG scan reads one snapshot of this policy. A saved change applies to the next natural EPG generation; a running scan keeps its revision.'};
function channelActivation(){return CHANNEL_ACTIVATION;}
const CHANNEL_REQUEST_ID=/^[A-Za-z0-9_-]{8,80}$/;
const CHANNEL_STATUS={invalid:400,unknown_channel:404,unknown_category:400,conflict:409,unavailable:503};

function channelError(error,status,extra){return json({error,...(extra||{})},status);}
function channelNow(){return new Date().toISOString();}
// Published FILM-show presence: published_epg_show carries only the shows matched to a Film. A channel without such a row is NOT proven absent from the raw XMLTV schedule.
async function channelPresence(db){
 try{
  const rows=(await db.prepare('SELECT channel_id AS channelId, COUNT(*) AS shows, MAX(start_ms) AS lastStartMs FROM published_epg_show WHERE programme_run_id=(SELECT programme_run_id FROM published_epg_authority WHERE id=1) GROUP BY channel_id').all()).results||[];
  return new Map(rows.map(row=>[row.channelId,{shows:Number(row.shows),lastStartMs:Number(row.lastStartMs)}]));
 }catch{return null;}
}
function channelUnavailable(snapshot,env){
 return channelError('channel_authority_unavailable',503,{reason:snapshot.reason,activation:channelActivation(env)});
}
function channelOffset(value){const n=Number(value);return Number.isInteger(n)&&n>=0&&n<=1000000?n:0;}
function channelLimit(value){const n=Number(value);return Number.isInteger(n)&&n>=1?Math.min(n,CHANNEL_PAGE_MAX):CHANNEL_PAGE_DEFAULT;}

async function channelList(request,env,url){
 const db=env.DB;
 if(!db)return channelError('channel_authority_unavailable',503,{reason:'unavailable'});
 const snapshot=await EpgChannelD1.readSnapshot(db);
 if(!snapshot.ok){
  if(snapshot.reason==='absent')return json({available:false,reason:'absent',activation:channelActivation(env)});
  return channelUnavailable(snapshot,env);
 }
 const params=url.searchParams;
 const filters={q:(params.get('q')||'').slice(0,100),category:(params.get('category')||'').slice(0,160),policy:params.get('policy')||'',source:params.get('source')||'',queue:params.get('queue')||''};
 const presence=await channelPresence(db);
 const rows=[...snapshot.channels.values()].map(channel=>EpgChannelAdmin.channelView(channel,snapshot.categories,presence));
 const counts=new Map();let unclassified=0,unlisted=0,overrides=0;
 const byPolicy={deny_all:0,discover:0,known_only:0};
 for(const row of rows){
  byPolicy[row.effective.policy]+=1;
  if(row.effective.basis==='unclassified')unclassified+=1;
  if(!row.listed)unlisted+=1;
  if(row.overridePolicy)overrides+=1;
  const key=row.ownerCategory?.key??row.category?.key??null;
  if(key!==null)counts.set(key,(counts.get(key)||0)+1);
 }
 const matched=EpgChannelAdmin.filterChannels(rows,filters);
 const offset=channelOffset(params.get('offset')),limit=channelLimit(params.get('limit'));
 const page=matched.slice(offset,offset+limit);
 return json({
  available:true,revision:snapshot.revision,importRevision:snapshot.importRevision,empty:snapshot.empty,sourceSha256:snapshot.sourceSha256,
  activation:channelActivation(env),presence:{available:presence!==null},
  totals:{channels:rows.length,unclassified,unlisted,overrides,byPolicy},
  categories:[...snapshot.categories.values()].sort((a,b)=>a.position-b.position).map(category=>({key:category.categoryKey,name:category.name,policy:category.policy,position:category.position,channels:counts.get(category.categoryKey)||0})),
  channels:page,page:{offset,limit,total:matched.length,next:offset+limit<matched.length?offset+limit:null},filters,
 });
}

// The shared write gate. -> {error:Response} | {body:object}
async function channelGate(request,url){
 if(request.method!=='POST')return {error:channelError('method_not_allowed',405)};
 if(request.headers.get('Origin')!==url.origin)return {error:channelError('origin_not_allowed',403)};
 if(request.headers.get('X-IPTV-Admin-Action')!==CHANNEL_ACTION)return {error:channelError('action_not_allowed',403)};
 const type=(request.headers.get('Content-Type')||'').split(';')[0].trim().toLowerCase();
 if(type!=='application/json')return {error:channelError('invalid_json',400)};
 const max=EpgChannelAdmin.SUBMISSION_LIMITS.bodyBytes;
 const length=request.headers.get('Content-Length');
 if(length!==null&&(!/^\d{1,9}$/.test(length)||Number(length)>max))return {error:channelError('body_too_large',413)};
 let text;
 try{text=await request.text();}catch{return {error:channelError('invalid_json',400)};}
 if(text.length>max)return {error:channelError('body_too_large',413)};
 let body;
 try{body=JSON.parse(text);}catch{return {error:channelError('invalid_json',400)};}
 if(!body||typeof body!=='object'||Array.isArray(body))return {error:channelError('invalid_json',400)};
 return {body};
}
function channelWriteFields(body,{needChannel}){
 if(body.confirm!==true)return channelError('confirmation_required',400);
 if(typeof body.requestId!=='string'||!CHANNEL_REQUEST_ID.test(body.requestId))return channelError('invalid_request_id',400);
 if(!Number.isInteger(body.expectedRevision)||body.expectedRevision<0)return channelError('invalid_revision',400);
 if(needChannel&&!EpgChannelD1.isChannelId(body.channelId))return channelError('invalid_channel',400);
 if(!EpgChannelAdmin.validateNote(body.note))return channelError('invalid_note',400);
 return null;
}
const channelStale=snapshot=>channelError('stale_revision',409,{currentRevision:snapshot.revision,recovery:'Reload the snapshot and repeat the change on the new revision.'});

// Plan from the normalized submission. The stored XMLTV-only registrations are carried over so an import that never saw XMLTV neither unlists nor re-registers them.
function channelPlan(snapshot,submission){
 const xmltvChannels=[...snapshot.channels.values()].filter(channel=>channel.origin==='xmltv').map(channel=>({channelId:channel.channelId,name:channel.name}));
 return EpgChannelD1.planImport({groups:submission.groups,entries:submission.entries,xmltvChannels});
}
const CHANNEL_BODY_KEYS=['groups','entries','requestId','expectedRevision','sourceSha256','confirm'];
function channelSubmission(body){
 if(!Object.keys(body).every(key=>CHANNEL_BODY_KEYS.includes(key)))return {error:channelError('invalid_import',422,{errors:[{code:'unknown_field'}]})};
 const submission=EpgChannelAdmin.validateSubmission(body);
 return submission.ok?{submission}:{error:channelError('invalid_import',422,{errors:submission.errors})};
}

async function channelPreview(env,body){
 const db=env.DB;if(!db)return channelError('channel_authority_unavailable',503,{reason:'unavailable'});
 const snapshot=await EpgChannelD1.readSnapshot(db);
 if(!snapshot.ok)return channelUnavailable(snapshot,env);
 const checked=channelSubmission(body);if(checked.error)return checked.error;
 const plan=channelPlan(snapshot,checked.submission);
 if(!plan.ok)return channelError('invalid_import',422,{errors:plan.errors});
 const digest=await EpgChannelD1.planDigest(plan);
 return json({mode:'preview',writes:false,revision:snapshot.revision,empty:snapshot.empty,unchanged:snapshot.revision>0&&snapshot.planSha256===digest,activation:channelActivation(env),preview:EpgChannelAdmin.buildPreview(snapshot,plan)});
}

async function channelReadback(db,check){
 try{const fresh=await EpgChannelD1.readSnapshot(db);return fresh.ok&&check(fresh)?fresh:null;}catch{return null;}
}
async function channelFresh(db,fallback){const fresh=await EpgChannelD1.readSnapshot(db);return fresh.ok?fresh:fallback;}
function channelFailure(result,snapshot){
 const status=CHANNEL_STATUS[result.reason]||503;
 if(result.reason==='conflict')return channelStale(snapshot);
 return channelError(result.reason==='unavailable'?'storage_unavailable':result.reason,status,result.reason==='unavailable'?{outcome:'unknown',recovery:'Reload the snapshot: the write may or may not have been stored.'}:undefined);
}

async function channelImport(env,body){
 const db=env.DB;if(!db)return channelError('channel_authority_unavailable',503,{reason:'unavailable'});
 const invalid=channelWriteFields(body,{needChannel:false});if(invalid)return invalid;
 if(typeof body.sourceSha256!=='string'||!/^[0-9a-f]{64}$/.test(body.sourceSha256))return channelError('invalid_source_digest',400);
 const checked=channelSubmission(body);if(checked.error)return checked.error;
 const snapshot=await EpgChannelD1.readSnapshot(db);
 if(!snapshot.ok)return channelUnavailable(snapshot,env);
 const plan=channelPlan(snapshot,checked.submission);
 if(!plan.ok)return channelError('invalid_import',422,{errors:plan.errors});
 const digest=await EpgChannelD1.planDigest(plan);
 const receipt=revision=>({requestId:body.requestId,planSha256:digest,sourceSha256:body.sourceSha256,categories:plan.categories.length,channels:plan.channels.length,revision});
 // A retry of an import that already landed (or a repeat of the stored plan): exact whole-plan match, nothing written.
 if(snapshot.revision>0&&snapshot.planSha256===digest)return json({ok:true,mode:'import',idempotent:true,changed:false,revision:snapshot.revision,receipt:receipt(snapshot.revision),activation:channelActivation(env)});
 if(snapshot.revision!==body.expectedRevision)return channelStale(snapshot);
 const result=await EpgChannelD1.commitImport(db,{expectedRevision:body.expectedRevision,sourceSha256:body.sourceSha256,plan,now:channelNow()});
 if(!result.ok)return channelFailure(result,await channelFresh(db,snapshot));
 const fresh=await channelReadback(db,next=>next.revision===result.revision&&next.planSha256===digest);
 if(!fresh)return channelError('readback_failed',503,{outcome:'unknown',recovery:'Reload the snapshot to see whether the import was stored.'});
 return json({ok:true,mode:'import',idempotent:false,changed:true,previousRevision:body.expectedRevision,revision:fresh.revision,receipt:receipt(fresh.revision),activation:channelActivation(env)});
}

async function channelDecision(env,body,kind){
 const db=env.DB;if(!db)return channelError('channel_authority_unavailable',503,{reason:'unavailable'});
 const invalid=channelWriteFields(body,{needChannel:true});if(invalid)return invalid;
 const note=body.note===undefined?null:body.note;
 const isOverride=kind==='override';
 const value=isOverride?body.policy:body.categoryKey;
 if(value===undefined)return channelError(isOverride?'invalid_policy':'invalid_category',400);
 if(isOverride&&value!==null&&!EpgChannelD1.POLICIES.includes(value))return channelError('invalid_policy',400);
 if(!isOverride&&value!==null&&(typeof value!=='string'||!value||value.length>160))return channelError('invalid_category',400);
 const snapshot=await EpgChannelD1.readSnapshot(db);
 if(!snapshot.ok)return channelUnavailable(snapshot,env);
 const stored=snapshot.channels.get(body.channelId);
 if(!stored)return channelError('unknown_channel',404);
 if(!isOverride&&value!==null&&!snapshot.categories.has(value))return channelError('unknown_category',400);
 const current=isOverride?stored.overridePolicy:stored.ownerCategoryKey;
 const currentNote=isOverride?stored.overrideNote:stored.ownerCategoryNote;
 const answer=(revision,changed)=>({ok:true,mode:kind,idempotent:!changed,changed,channelId:body.channelId,revision,previousRevision:changed?body.expectedRevision:undefined,receipt:{requestId:body.requestId,channelId:body.channelId,value,note:value===null?null:note,revision},activation:channelActivation(env)});
 // The stored decision already is exactly this request (a retry, or a repeat): nothing is written, whatever revision the caller read.
 if((current??null)===value&&(value===null||(currentNote??null)===note))return json(answer(snapshot.revision,false));
 if(snapshot.revision!==body.expectedRevision)return channelStale(snapshot);
 const args={expectedRevision:body.expectedRevision,channelId:body.channelId,note,now:channelNow()};
 const result=isOverride?await EpgChannelD1.setOverride(db,{...args,policy:value}):await EpgChannelD1.setOwnerCategory(db,{...args,categoryKey:value});
 if(!result.ok)return channelFailure(result,await channelFresh(db,snapshot));
 const fresh=await channelReadback(db,next=>{
  const row=next.channels.get(body.channelId);
  return next.revision===result.revision&&row&&((isOverride?row.overridePolicy:row.ownerCategoryKey)??null)===value;
 });
 if(!fresh)return channelError('readback_failed',503,{outcome:'unknown',recovery:'Reload the snapshot to see whether the change was stored.'});
 return json(answer(fresh.revision,true));
}

async function adminChannelsRoute(request,env,url){
 const rest=url.pathname.slice('/api/admin/channels'.length);
 if(rest===''||rest==='/'){
  if(request.method!=='GET')return channelError('method_not_allowed',405);
  return await channelList(request,env,url);
 }
 if(!['/preview','/import','/override','/category'].includes(rest))return channelError('not_found',404);
 const gate=await channelGate(request,url);
 if(gate.error)return gate.error;
 try{
  if(rest==='/preview')return await channelPreview(env,gate.body);
  if(rest==='/import')return await channelImport(env,gate.body);
  return await channelDecision(env,gate.body,rest==='/override'?'override':'category');
 }catch{return channelError('storage_unavailable',503,{outcome:'unknown'});}
}
