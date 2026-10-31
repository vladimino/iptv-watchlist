// Browser client of the poster page, behind the same Cloudflare Access session as the page. `loadPosterCoverage` is one GET to
// /api/admin/posters; `posterHydrationCall` is one explicit POST to the existing maintenance route
// /api/enrichment/catalog/posters, sent only by a run the owner confirmed. It sends no credential and no token: the browser
// session is the only authorization, and the route's own guards decide what is written.
const POSTER_HYDRATION_ROUTE='/api/enrichment/catalog/posters';
async function loadPosterCoverage(state,options={}){
 return adminCall('/posters',{limit:state.limit||null,cursor:state.cursor||null},{fetch:options.fetch,signal:options.signal});
}
// One POST. The answer has the shape of adminCall: {ok, status, error, body}; a body that is not JSON is `null`.
async function posterHydrationCall(body,options={}){
 const fetchImpl=options.fetch||globalThis.fetch;
 let response;
 try{response=await fetchImpl(POSTER_HYDRATION_ROUTE,{method:'POST',headers:{Accept:'application/json','Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify(body)});}
 catch(error){return {ok:false,status:0,error:error&&error.name==='AbortError'?'aborted':'network',body:null};}
 let parsed=null;
 try{parsed=await response.json();}catch{parsed=null;}
 if(!response.ok)return {ok:false,status:response.status,error:parsed&&typeof parsed.error==='string'?parsed.error:'http_'+response.status,body:parsed};
 return {ok:true,status:response.status,error:null,body:parsed};
}
