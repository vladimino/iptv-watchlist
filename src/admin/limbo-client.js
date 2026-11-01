// Browser client of the limbo inventory route, behind the same Cloudflare Access session as the page. One GET per view
// to /api/admin/limbo with the filter from the URL and the snapshot pin the page holds; one more GET per "show more"
// under the same pin; one GET to /api/admin/prediction-recovery per film the owner opens. It stores nothing and sends no
// credential. A 409, or a pin that differs from the held one, is a
// stale snapshot the page must say out loud, never a silent refill.
const LIMBO_PAGE_LIMIT=25;
function limboParams(state,cursor){
 return {kind:state.kind||null,subsystem:state.subsystem||null,cause:state.cause||null,age:state.age===''||state.age===null||state.age===undefined?null:state.age,limit:LIMBO_PAGE_LIMIT,cursor:cursor||null};
}
function limboEmptyView(state,options){
 return {pin:options.pin||null,snapshot:options.snapshot||null,mode:'ready',error:null,kind:state.kind,subsystem:state.subsystem,cause:state.cause,age:state.age,items:[],nextCursor:null,total:0,counts:null,coverage:null,context:[],unread:[],thresholds:null};
}
async function loadLimboLive(state,options={}){
 const view=limboEmptyView(state,options);
 const result=await adminCall('/limbo',limboParams(state,null),{fetch:options.fetch,signal:options.signal,pin:options.pin||null});
 if(result.error==='aborted'){view.mode='aborted';return view;}
 if(result.status===409){view.mode='stale';view.error='stale_pin';return view;}
 if(!result.ok){view.mode='error';view.error=result.error;return view;}
 const body=result.body||{};
 if(options.pin&&body.pin&&body.pin!==options.pin){view.mode='stale';view.error='stale_pin';return view;}
 view.pin=body.pin||null;view.snapshot=body.snapshot||null;
 view.items=body.items||[];view.nextCursor=body.nextCursor||null;view.total=Number.isInteger(body.total)?body.total:view.items.length;
 view.counts=body.counts||null;view.coverage=body.coverage||null;view.context=body.context||[];view.unread=body.unread||[];view.thresholds=body.thresholds||null;
 return view;
}
async function loadLimboMore(state,cursor,options={}){
 const result=await adminCall('/limbo',limboParams(state,cursor),{fetch:options.fetch,signal:options.signal,pin:options.pin||null});
 if(result.status===409)return {mode:'stale',error:'stale_pin',items:[],nextCursor:null};
 if(!result.ok)return {mode:'error',error:result.error,items:[],nextCursor:null};
 if(options.pin&&result.body?.pin&&result.body.pin!==options.pin)return {mode:'stale',error:'stale_pin',items:[],nextCursor:null};
 return {mode:'ready',error:null,items:result.body.items||[],nextCursor:result.body.nextCursor||null};
}
// The prediction recovery assessment of one stored film: one GET, with the pin of the previous check of the same film when
// there is one. A 409 means the state changed since; the fresh assessment is read once more without the pin and marked
// `changed`, so the owner never reads an old verdict as the current one.
async function loadPredictionRecovery(filmId,options={}){
 const common={fetch:options.fetch,signal:options.signal};
 const result=await adminCall('/prediction-recovery',{film:filmId},{...common,pin:options.pin||null});
 if(result.error==='aborted')return {mode:'aborted'};
 if(result.status===409&&options.pin){
  const fresh=await adminCall('/prediction-recovery',{film:filmId},common);
  if(fresh.error==='aborted')return {mode:'aborted'};
  return fresh.ok?{mode:'ready',changed:true,answer:fresh.body}:{mode:'error',error:fresh.error};
 }
 if(!result.ok)return {mode:'error',error:result.error};
 return {mode:'ready',changed:false,answer:result.body};
}
// The discovery recovery assessment of one observation: the same pin rule as above.
async function loadDiscoveryRecovery(key,options={}){
 const common={fetch:options.fetch,signal:options.signal};
 const result=await adminCall('/discovery-recovery',{key},{...common,pin:options.pin||null});
 if(result.error==='aborted')return {mode:'aborted'};
 if(result.status===409&&options.pin){
  const fresh=await adminCall('/discovery-recovery',{key},common);
  if(fresh.error==='aborted')return {mode:'aborted'};
  return fresh.ok?{mode:'ready',changed:true,answer:fresh.body}:{mode:'error',error:fresh.error};
 }
 if(!result.ok)return {mode:'error',error:result.error};
 return {mode:'ready',changed:false,answer:result.body};
}
// The two owner POSTs of `discovery_reconsider`. Same-origin JSON with the action named in a header; the Access session
// is the only credential. A request that does not reach the Worker is `network`: its outcome is unknown, never retried.
async function discoveryActionPost(path,body,options={}){
 const fetchImpl=options.fetch||globalThis.fetch;
 let response;
 try{response=await fetchImpl(ADMIN_API+'/discovery-recovery/'+path,{method:'POST',headers:{Accept:'application/json','Content-Type':'application/json','X-IPTV-Admin-Action':'discovery_reconsider'},credentials:'same-origin',body:JSON.stringify(body)});}
 catch{return {ok:false,status:0,error:'network',body:null};}
 let parsed=null;
 try{parsed=await response.json();}catch{parsed=null;}
 if(!response.ok)return {ok:false,status:response.status,error:parsed&&typeof parsed.refusal==='string'?parsed.refusal:parsed&&typeof parsed.error==='string'?parsed.error:'http_'+response.status,body:parsed};
 return {ok:true,status:response.status,error:null,body:parsed};
}
function discoveryIdempotencyKey(){
 const bytes=crypto.getRandomValues(new Uint8Array(18));
 return Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join('');
}
async function confirmDiscoveryReconsider(key,pin,options={}){
 return await discoveryActionPost('confirm',{key,pin,idempotencyKey:options.idempotencyKey||discoveryIdempotencyKey(),accepted:true},options);
}
async function executeDiscoveryReconsider(confirmation,options={}){
 return await discoveryActionPost('reconsider',{confirmation},options);
}
// The owner correction of one observation's identity. A different action header from reconsideration, so a
// reconsideration confirmation cannot be posted here and this body cannot be posted as a reconsideration.
async function discoveryIdentityPost(path,body,options={}){
 const fetchImpl=options.fetch||globalThis.fetch;
 let response;
 try{response=await fetchImpl(ADMIN_API+'/discovery-recovery/'+path,{method:'POST',headers:{Accept:'application/json','Content-Type':'application/json','X-IPTV-Admin-Action':'discovery_identity_correct'},credentials:'same-origin',body:JSON.stringify(body)});}
 catch{return {ok:false,status:0,error:'network',body:null};}
 let parsed=null;
 try{parsed=await response.json();}catch{parsed=null;}
 if(!response.ok)return {ok:false,status:response.status,error:parsed&&typeof parsed.refusal==='string'?parsed.refusal:parsed&&typeof parsed.error==='string'?parsed.error:'http_'+response.status,body:parsed};
 return {ok:true,status:response.status,error:null,body:parsed};
}
async function confirmDiscoveryIdentity(body,options={}){
 return await discoveryIdentityPost('identity-confirm',{...body,idempotencyKey:options.idempotencyKey||discoveryIdempotencyKey(),accepted:true},options);
}
async function executeDiscoveryIdentity(confirmation,options={}){
 return await discoveryIdentityPost('identity-correct',{confirmation},options);
}
