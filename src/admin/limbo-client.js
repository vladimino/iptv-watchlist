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
