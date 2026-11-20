// ADR 0181 / AIR-131: owner-confirmed group assign of up to ten explicitly selected EPG observations to one movie.
//   GET  /api/admin/discovery-recovery/group-preview?tmdbId=      read-only, bounded D1 preview: candidates, proofs, conflicts, before and after
//   POST /api/admin/discovery-recovery/group-confirm              one confirmation of exactly the selected keys; N child intents in ONE D1 batch
//   POST /api/admin/discovery-recovery/group-execute              sequential fenced per-key owner writes behind an issuance barrier
//   GET  /api/admin/discovery-recovery/group-receipt?groupKey=    the per-key children and receipts of one group; read-only
// D1 only. A group is a convenience over single-key owner writes: every key is written by DiscoveryAuthority.ownerDecision with its own
// intent, history row and receipt. No TMDB, no model, no Discovery chunk, no EPG run, no R2 on any of these paths.
const IG_CAPABILITY=AdminActions.defineCapability({
 id:'discovery_identity_group_assign',version:1,title:'Assign one movie to a selected group of discovery observations',
 subjectKinds:['observation'],healthActionCode:'discovery_identity_group_assign',
 budget:{maxRecords:10,maxWritesPerRecord:1,externalCallsPerRecord:0},retry:{maxAttempts:1,backoffMs:0},
 compensation:{kind:'manual',guidance:'No group undo. Each key is an ordinary owner assignment with its own receipt; revoke or supersede one key with discovery_identity_revoke. A group never restores a before-image.'},
 confirmTtlMs:10*60000,
});
const IG_REGISTRY=AdminActions.createRegistry([IG_CAPABILITY]);
const IG_TMDB=/^[1-9]\d{0,11}$/;

function igRecord(proof){
 const observation=proof?.observation||null;
 if(!observation)return null;
 return {key:proof.key,normalizedTitle:observation.normalizedTitle??null,year:observation.year??null,durations:Array.isArray(observation.durations)?observation.durations:[],confirmedTmdbId:observation.confirmedTmdbId??null,decision:proof.decision||null};
}
// The per-key D1 proof run through the unchanged single-key gate plus the group-only refusals.
function igAssess(tmdbId,film,proof){
 const record=igRecord(proof);
 if(!record)return DiscoveryIdentityGroup.groupAssess({tmdbId,film,proof:null});
 const assessed=DiscoveryIdentityGroup.groupAssess({tmdbId,film,proof:{record,decisionHash:proof.decisionHash,hashOk:proof.hashOk===true,current:proof.observation.belongsToPublishedRun===true}});
 return assessed;
}
function igFilmTitles(film){
 const raw=[film?.title,film?.original,...(Array.isArray(film?.aliases)?film.aliases:[]),...(Array.isArray(film?.movieTitles)?film.movieTitles:[])];
 return raw.filter(value=>typeof value==='string'&&value).map(value=>epgTitleParts(value).normalizedTitle);
}
function igRowView(candidate,proof,assessment){
 const observation=proof?.observation||null,decision=proof?.decision||null;
 return {
  key:candidate.key,anchors:candidate.anchors,
  observation:observation?{title:observation.title??null,year:observation.year??null,durations:Array.isArray(observation.durations)?observation.durations.slice(0,6):[],confirmedTmdbId:observation.confirmedTmdbId??null,evidenceKey:observation.evidenceKey??null}:null,
  shows:proof?.shows||[],
  decision:decision?{status:decision.status??null,tmdbId:decision.tmdbId??null,ownerEffect:decision.ownerIdentity?.effect??null,acceptedTmdbId:decision.scoring?.acceptedTmdbId??null}:null,
  decisionHash:proof?.decisionHash??null,
  selectable:assessment.selectable,reasons:assessment.reasons,info:assessment.info,runtime:assessment.runtime,yearGap:assessment.yearGap??null,version:assessment.version,plan:assessment.plan,
 };
}
// The bounded read shared by preview, confirm and (per key) execute. Nothing here writes.
async function igObserve(env,tmdbId){
 const gate=await DiscoveryAuthority.readGateSnapshot(env);
 if(!gate.ready)return {error:'not_authoritative'};
 const found=await DiscoveryAuthority.readGroupFilm(env,tmdbId);
 if(!found.handled)return {error:'not_authoritative'};
 if(!found.film)return {error:found.reason==='not_movie'?'film_not_movie':'film_absent',reason:found.reason};
 if(found.reason==='not_current')return {error:'film_absent',reason:found.reason};
 const film=found.film;
 const {anchors,omitted}=DiscoveryIdentityGroup.groupAnchors(igFilmTitles(film));
 const ranges=anchors.map(anchor=>({anchor,...DiscoveryIdentityGroup.groupRange(anchor)}));
 const read=await DiscoveryAuthority.readGroupCandidates(env,ranges,DiscoveryIdentityGroup.GROUP_ANCHOR_FETCH);
 if(!read.handled)return {error:'not_authoritative'};
 const merge=DiscoveryIdentityGroup.groupMerge(read.perAnchor);
 const proofRead=await DiscoveryAuthority.readGroupProofs(env,merge.candidates.map(item=>item.key),DiscoveryIdentityGroup.GROUP_CANDIDATE_MAX);
 if(!proofRead.handled)return {error:'not_authoritative'};
 const writer=await DiscoveryAuthority.readWriterActive(env);
 const rows=merge.candidates.map(candidate=>{
  const proof=proofRead.proofs[candidate.key];
  return {candidate,proof,assessment:igAssess(tmdbId,film,proof)};
 });
 const programmeRunId=proofRead.gate.programmeRunId;
 const tuple=[programmeRunId,tmdbId,anchors,rows.map(row=>[row.candidate.key,row.proof?.decisionHash??null,row.proof?.observation?.evidenceKey??null])];
 const pin='D1.'+(await adminDigest(JSON.stringify(tuple))).slice(0,32);
 return {
  tmdbId,film,programmeRunId,generation:proofRead.gate.generation,pin,writerActive:writer.active===true,
  coverage:{kind:'partial',anchors:merge.anchors,anchorsOmitted:omitted,merged:merge.merged,shown:merge.shown,dropped:merge.dropped,truncated:merge.truncated},
  rows,
 };
}
function igFilmView(film,tmdbId){
 return {tmdbId,title:film.title??null,original:film.original??null,year:film.year??null,runtime:film.runtime??null};
}
async function igPreview(request,env,url){
 const tmdbId=url.searchParams.get('tmdbId');
 if(!tmdbId||!IG_TMDB.test(tmdbId))return drRefused('invalid_request',400);
 const observed=await igObserve(env,tmdbId);
 if(observed.error)return json({tmdbId,available:false,reason:observed.error,coverage:null,rows:[],pin:null},observed.error==='not_authoritative'?409:200);
 return json({
  tmdbId,available:true,reason:null,pin:observed.pin,programmeRunId:observed.programmeRunId,generation:observed.generation,
  film:igFilmView(observed.film,tmdbId),coverage:observed.coverage,writerActive:observed.writerActive,
  limits:{maxKeys:DiscoveryIdentityGroup.GROUP_MAX_KEYS,maxCandidates:DiscoveryIdentityGroup.GROUP_CANDIDATE_MAX},
  rows:observed.rows.map(row=>igRowView(row.candidate,row.proof,row.assessment)),
 });
}
async function igConfirm(request,env,url){
 if(!diPrincipal(request,url).owner)return drRefused('access_denied',403);
 const body=await drBody(request);
 if(!body)return drRefused('invalid_request',400);
 const tmdbId=typeof body.tmdbId==='string'?body.tmdbId:String(body.tmdbId??'');
 if(!IG_TMDB.test(tmdbId)||typeof body.pin!=='string'||!DR_PIN.test(body.pin)||typeof body.idempotencyKey!=='string'||!DiscoveryIdentityGroup.GROUP_KEY_PATTERN.test(body.idempotencyKey))return drRefused('invalid_request',400);
 if(body.accepted!==true)return drRefused('confirmation_missing',400);
 const basis=DiscoveryIdentityGroup.groupBasis(body.basis);
 if(!basis)return drRefused('basis_required',400);
 const selection=DiscoveryIdentityGroup.groupSelection(body.keys);
 if(!selection.ok)return drRefused(selection.reason,selection.reason==='group_too_large'?409:400);
 const observed=await igObserve(env,tmdbId);
 if(observed.error)return drRefused(observed.error==='not_authoritative'?'not_authoritative':'not_eligible',409,{reason:observed.error});
 if(observed.pin!==body.pin)return drRefused('stale_pin',409,{pin:observed.pin,reason:'stale_pin'});
 if(observed.writerActive)return drRefused('writer_active',409,{pin:observed.pin});
 // Exact binding: the whole confirmation binds the owner's explicit keys, never an eligible subset.
 const byKey=new Map(observed.rows.map(row=>[row.candidate.key,row]));
 const versions={},records=[],issues=[];
 for(const key of selection.keys){
  const row=byKey.get(key);
  if(row&&row.assessment.version){versions[key]=row.assessment.version;records.push({id:key,version:row.assessment.version});}
  issues.push({id:IG_CAPABILITY.id+':'+key,subject:{kind:'observation',id:key},action:{code:IG_CAPABILITY.healthActionCode,eligible:row?row.assessment.selectable:false,reason:row?(row.assessment.reasons[0]||'eligible'):'record_not_read'},evidence:{completeness:'complete'}});
 }
 const now=new Date().toISOString();
 const preview=AdminActions.previewAction(IG_REGISTRY,{capability:IG_CAPABILITY.id,version:IG_CAPABILITY.version,subject:{kind:'observation',id:'tmdb:'+tmdbId},pin:body.pin,ids:selection.keys},{pin:observed.pin,now,records,issues});
 const exact=DiscoveryIdentityGroup.groupExactSelection(selection.keys,preview,versions);
 if(!exact.ok)return drRefused('group_selection_changed',409,{pin:observed.pin,failing:exact.failing});
 const issued=AdminActions.confirmAction(preview,{now,idempotencyKey:body.idempotencyKey,accepted:true});
 if(issued.error)return drRefused(issued.error,409,{pin:observed.pin});
 const expiresAt=Date.parse(issued.expiresAt);
 const groupId=body.idempotencyKey,size=selection.keys.length;
 const specs=selection.keys.map((key,index)=>({
  idempotencyKey:DiscoveryIdentityGroup.groupChildKey(groupId,index+1),kind:'identity_assign',observationKey:key,issued,
  command:{effect:'assign',tmdbId,basis,group:{id:groupId,size,index:index+1,anchorTmdbId:tmdbId,programmeRunId:observed.programmeRunId}},
  expectedHash:byKey.get(key).proof.decisionHash,expiresAt,
 }));
 // All N children or none: one D1 batch. A group key already used is refused and nothing is written.
 const saved=await DiscoveryAuthority.putIntents(env,specs,DiscoveryIdentityGroup.GROUP_MAX_KEYS);
 if(!saved.saved)return drRefused('idempotency_conflict',409);
 return json({
  confirmation:issued,group:{id:groupId,size,tmdbId,programmeRunId:observed.programmeRunId},
  members:selection.keys.map((key,index)=>{const row=byKey.get(key);return {key,index:index+1,version:versions[key],plan:row.assessment.plan,info:row.assessment.info,shows:row.proof.shows};}),
  cost:{writes:size,externalCalls:0},
 });
}
function igOutcome(result){
 if(result.outcome==='written'||result.outcome==='replay')return {outcome:'applied',stop:null,receipt:result.receipt||null};
 if(result.outcome==='unknown')return {outcome:'unknown',stop:'unknown'};
 if(result.outcome==='lease')return {outcome:'not_attempted',stop:'lease_lost',reason:'lease_lost'};
 if(result.outcome==='expired')return {outcome:'expired',stop:null,reason:'expired'};
 return {outcome:'conflict',stop:null,reason:result.outcome||'conflict'};
}
async function igExecute(request,env,url){
 if(!diPrincipal(request,url).owner)return drRefused('access_denied',403);
 const body=await drBody(request);
 const submitted=AdminActions.validateConfirmation(body?.confirmation);
 if(!submitted||submitted.capability!==IG_CAPABILITY.id)return drRefused(submitted?'unsupported_capability':'invalid_request',400);
 const ids=submitted.ids;
 const versions={};
 for(const entry of submitted.records||[])versions[entry.id]=entry.version;
 if(!ids.length||ids.length>DiscoveryIdentityGroup.GROUP_MAX_KEYS||ids.some(id=>typeof versions[id]!=='string'))return drRefused('invalid_request',400);
 const groupId=submitted.idempotencyKey;
 if(!DiscoveryIdentityGroup.GROUP_KEY_PATTERN.test(groupId))return drRefused('invalid_request',400);
 const gate=await DiscoveryAuthority.readGateSnapshot(env);
 if(!gate.ready)return drRefused('not_authoritative',409);
 const childKeys=ids.map((_,index)=>DiscoveryIdentityGroup.groupChildKey(groupId,index+1));
 const read=await DiscoveryAuthority.readIntents(env,childKeys);
 const children=read.intents;
 const first=children[0];
 if(!first)return drRefused('confirmation_missing',409);
 const member=first.command?.group||{};
 const group={id:groupId,tmdbId:String(first.command?.tmdbId??''),programmeRunId:member.programmeRunId,ids,versions};
 // The execution barrier: the full ordered member set proven against the ISSUED scope before any write. Never recreate a child.
 const barrier=DiscoveryIdentityGroup.groupBarrier({group,children});
 if(!barrier.ok){
  if(barrier.reason==='group_running')return drRefused('in_progress',409,{state:'unknown',reason:'group_running'});
  return drRefused(barrier.reason,409,{failing:barrier.failing});
 }
 const now=new Date().toISOString();
 const bound=AdminActions.bindIssuance(first.issued,body.confirmation,now);
 const pending=children.filter(child=>child.state==='approved');
 if(!pending.length){
  if(!bound.ok&&bound.refusal!=='confirmation_expired')return drRefused(bound.refusal,409);
  return json({replayed:true,state:'applied',group:{id:groupId,size:ids.length,tmdbId:group.tmdbId},outcomes:children.map((child,index)=>({key:child.observationKey,index:index+1,outcome:'applied',replayed:true,receipt:child.receipt}))});
 }
 if(!bound.ok)return drRefused(bound.refusal,409);
 if(gate.programmeRunId!==group.programmeRunId)return drRefused('programme_moved',409);
 const found=await DiscoveryAuthority.readGroupFilm(env,group.tmdbId);
 if(!found.film||found.reason)return drRefused('not_eligible',409,{reason:found.reason||'film_absent'});
 const lease=await acquireDiscoveryLease(env);
 if(!lease)return drRefused('lease_held',409);
 const outcomes=[];
 try{
  const startedAt=Date.now();
  let last=(await DiscoveryAuthority.readGateSnapshot(env)).generation;
  let stop=null;
  for(let index=0;index<ids.length;index++){
   const child=children[index],key=ids[index];
   const at={key,index:index+1};
   if(child.state==='receipt'){outcomes.push({...at,outcome:'applied',replayed:true,receipt:child.receipt});continue;}
   if(stop){outcomes.push({...at,outcome:'not_attempted',reason:stop});continue;}
   if(Date.now()-startedAt>DiscoveryIdentityGroup.GROUP_RUN_BUDGET_MS){stop='budget_exhausted';outcomes.push({...at,outcome:'not_attempted',reason:stop});continue;}
   if(child.expiresAt!=null&&child.expiresAt<=Date.now()){outcomes.push({...at,outcome:'expired',reason:'expired'});continue;}
   const renewed=await DiscoveryAuthority.renewLease(env,lease,{programmeRunId:group.programmeRunId});
   if(!renewed.ok){stop='lease_lost';outcomes.push({...at,outcome:'not_attempted',reason:stop});continue;}
   const observed=await DiscoveryAuthority.readGateSnapshot(env);
   const drift=DiscoveryIdentityGroup.groupDrift({baseProgrammeRunId:group.programmeRunId,observed,lastGeneration:last});
   if(drift){stop=drift;outcomes.push({...at,outcome:'not_attempted',reason:drift});continue;}
   const proofRead=await DiscoveryAuthority.readGroupProofs(env,[key],1);
   const proof=proofRead.proofs?.[key];
   const assessment=igAssess(group.tmdbId,found.film,proof);
   if(!assessment.selectable){outcomes.push({...at,outcome:'refused',reason:assessment.reasons[0]||'not_eligible'});continue;}
   if(assessment.version!==versions[key]){outcomes.push({...at,outcome:'conflict',reason:'decision_changed'});continue;}
   const identityBasis=await adminDigest(DiscoveryIdentity.identityBasisText(igRecord(proof)));
   const command=child.command;
   const next=DiscoveryIdentity.appliedIdentityDecision(proof.decision,{effect:'assign',tmdbId:group.tmdbId,basis:command.basis},{at:new Date().toISOString(),requestId:child.idempotencyKey,programmeRunId:group.programmeRunId,identityBasis});
   const result=await DiscoveryAuthority.ownerDecision(env,{idempotencyKey:child.idempotencyKey,key,expectedHash:child.expectedHash,next,lease,writer:'discovery_identity_correct',receipt:{state:'applied',capability:IG_CAPABILITY.id,effect:'assign',tmdbId:group.tmdbId,group:{id:groupId,index:index+1,size:ids.length},decisionHash:await DiscoveryAuthority.decisionHash(next)}});
   const mapped=igOutcome(result);
   outcomes.push({...at,outcome:mapped.outcome,...(mapped.reason?{reason:mapped.reason}:{}),...(mapped.receipt?{receipt:mapped.receipt}:{})});
   if(mapped.stop)stop=mapped.stop;
   const after=await DiscoveryAuthority.readGateSnapshot(env);
   if(after.ready)last=after.generation;
  }
 }finally{await releaseDiscoveryLease(env,lease);}
 return json({replayed:false,state:DiscoveryIdentityGroup.groupOutcomeState(outcomes),group:{id:groupId,size:ids.length,tmdbId:group.tmdbId},outcomes});
}
async function igReceipt(env,url){
 const groupKey=url.searchParams.get('groupKey');
 if(!groupKey||!DiscoveryIdentityGroup.GROUP_KEY_PATTERN.test(groupKey))return drRefused('invalid_request',400);
 const gate=await DiscoveryAuthority.readGateSnapshot(env);
 if(!gate.ready)return drRefused('not_authoritative',409);
 const head=await DiscoveryAuthority.readIntents(env,[DiscoveryIdentityGroup.groupChildKey(groupKey,1)]);
 const first=head.intents[0];
 const size=Number(first?.command?.group?.size);
 if(!first||first.command?.group?.id!==groupKey||!Number.isInteger(size)||size<1||size>DiscoveryIdentityGroup.GROUP_MAX_KEYS)return adminError('not_found',404);
 const keys=Array.from({length:size},(_,index)=>DiscoveryIdentityGroup.groupChildKey(groupKey,index+1));
 const read=await DiscoveryAuthority.readIntents(env,keys);
 const outcomes=keys.map((key,index)=>{
  const child=read.intents.find(item=>item.idempotencyKey===key);
  return {key:child?.observationKey??null,index:index+1,state:child?child.state:'missing',outcome:child?child.state==='receipt'?'applied':child.state==='running'?'unknown':'pending':'missing',receipt:child?.receipt??null};
 });
 return json({groupKey,size,tmdbId:first.command.tmdbId,complete:read.intents.length===size,outcomes});
}
async function adminIdentityGroupRoute(request,env,url,action){
 try{
  if(action==='group-preview')return request.method==='GET'?await igPreview(request,env,url):adminError('method_not_allowed',405);
  if(action==='group-receipt')return request.method==='GET'?await igReceipt(env,url):adminError('method_not_allowed',405);
  if(request.method!=='POST')return adminError('method_not_allowed',405);
  return action==='group-confirm'?await igConfirm(request,env,url):await igExecute(request,env,url);
 }catch{return drRefused('storage_unavailable',503);}
}
