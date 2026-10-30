// Browser client of the owner-only read API behind the same Cloudflare Access session as the page. It sends GET requests
// to /api/admin/* with the snapshot pin it holds, assembles one page view from the overview, the two searches and the
// detail read, and reports the pin and error states of each answer. It stores nothing and sends no credential: the
// browser session is the only authorization.
const ADMIN_API='/api/admin';
const ADMIN_PAGE_LIMIT=25;
const ADMIN_FILM_QUEUE_CODES=['localization-missing','localization-provisional','localization-conflict','identity-unresolved','identity-ambiguous','identity-rejected','metadata-missing','metadata-stale','metadata-failed','external-id-conflict'];
const ADMIN_PERSON_QUEUE_CODES=['localization-missing','localization-provisional','localization-conflict','external-id-conflict'];

function adminSearchParams(params,pin){
 const search=new URLSearchParams();
 for(const [name,value] of Object.entries(params||{}))if(value!==null&&value!==undefined&&value!=='')search.set(name,String(value));
 if(pin)search.set('pin',pin);
 const text=search.toString();
 return text?'?'+text:'';
}
// One GET. The answer is {ok, status, error, body}: `error` is the server code, `network` when the request did not reach
// the Worker, `aborted` when the caller cancelled it, `http_<status>` when the body carried no code.
async function adminCall(path,params,options={}){
 const fetchImpl=options.fetch||globalThis.fetch;
 let response;
 try{response=await fetchImpl(ADMIN_API+path+adminSearchParams(params,options.pin),{headers:{Accept:'application/json'},credentials:'same-origin',...(options.signal?{signal:options.signal}:{})});}
 catch(error){return {ok:false,status:0,error:error&&error.name==='AbortError'?'aborted':'network',body:null};}
 let body=null;
 try{body=await response.json();}catch{body=null;}
 if(!response.ok)return {ok:false,status:response.status,error:body&&typeof body.error==='string'?body.error:'http_'+response.status,body};
 return {ok:true,status:response.status,error:null,body};
}
function adminDetailPath(kind,id){return (kind==='person'?'/people/':'/films/')+encodeURIComponent(id);}
function adminQueueKinds(queue){
 return {film:!queue||ADMIN_FILM_QUEUE_CODES.includes(queue),person:!queue||ADMIN_PERSON_QUEUE_CODES.includes(queue)};
}
function adminEmptyView(state,options){
 return {demo:false,pin:options.pin||null,snapshot:options.snapshot||null,limit:ADMIN_PAGE_LIMIT,mode:'ready',error:null,query:state.q,queue:state.queue,kind:state.kind,id:state.id,entity:null,entityMissing:false,filmResults:[],personResults:[],filmNext:null,personNext:null,queues:options.queues||[],unavailableQueues:options.unavailableQueues||[],scope:state.q||state.queue?'results':'overview'};
}
// The page view for one URL state. `options.pin`, `options.queues` and `options.snapshot` are what the page already holds;
// the overview is fetched only when no queue list is held. Answers from different snapshots, or a 409, make the view
// `stale`: the page keeps what it shows and asks the owner to reload without the pin.
async function loadAdminLive(state,options={}){
 const view=adminEmptyView(state,options);
 const pin=options.pin||null,common={fetch:options.fetch,signal:options.signal,pin};
 const kinds=adminQueueKinds(state.queue);
 if(state.queue&&!kinds.film&&!kinds.person){view.mode='error';view.error='unknown_queue';return view;}
 const calls=[];
 if(!options.queues)calls.push(['overview',adminCall('/overview',{},common)]);
 if(state.q||state.queue){
  const params={q:state.q||null,queue:state.queue||null,limit:ADMIN_PAGE_LIMIT};
  if(kinds.film)calls.push(['films',adminCall('/films',params,common)]);
  if(kinds.person)calls.push(['people',adminCall('/people',params,common)]);
 }
 if(state.id)calls.push(['detail',adminCall(adminDetailPath(state.kind,state.id),{},common)]);
 const answers=await Promise.all(calls.map(([name,promise])=>promise.then(result=>[name,result])));
 if(answers.some(([,result])=>result.error==='aborted')){view.mode='aborted';return view;}
 const pins=new Set();
 for(const [name,result] of answers){
  if(result.status===409||(name==='detail'&&result.status===404&&result.body?.pin&&pin&&result.body.pin!==pin)){view.mode='stale';view.error='stale_pin';return view;}
  if(result.body&&typeof result.body.pin==='string')pins.add(result.body.pin);
 }
 if(pins.size>1){view.mode='stale';view.error='stale_pin';return view;}
 const failed=answers.find(([name,result])=>!result.ok&&!(name==='detail'&&result.status===404));
 if(failed){view.mode='error';view.error=failed[1].error;view.pin=pin;return view;}
 for(const [name,result] of answers){
  const body=result.body||{};
  if(body.pin){view.pin=body.pin;view.snapshot=body.snapshot||view.snapshot;}
  if(name==='overview'){view.queues=body.queues||[];view.unavailableQueues=body.unavailableQueues||[];}
  if(name==='films'){view.filmResults=body.items||[];view.filmNext=body.nextCursor||null;}
  if(name==='people'){view.personResults=body.items||[];view.personNext=body.nextCursor||null;}
  if(name==='detail'){if(result.status===404)view.entityMissing=true;else view.entity=body.item||null;}
 }
 return view;
}
// The next page of one group under the held pin. A 409 or a stale cursor is reported, never silently refilled.
async function loadAdminMore(state,kind,cursor,options={}){
 const result=await adminCall(kind==='person'?'/people':'/films',{q:state.q||null,queue:state.queue||null,limit:ADMIN_PAGE_LIMIT,cursor},{fetch:options.fetch,signal:options.signal,pin:options.pin});
 if(result.status===409)return {mode:'stale',error:'stale_pin',items:[],nextCursor:null};
 if(!result.ok)return {mode:'error',error:result.error,items:[],nextCursor:null};
 if(options.pin&&result.body?.pin&&result.body.pin!==options.pin)return {mode:'stale',error:'stale_pin',items:[],nextCursor:null};
 return {mode:'ready',error:null,items:result.body.items||[],nextCursor:result.body.nextCursor||null};
}
